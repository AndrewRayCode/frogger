import { parser, generate } from '@shaderfrog/glsl-parser';
import { ParserProgram } from '@shaderfrog/glsl-parser/dist/parser/parser';

import {
  renameBindings,
  renameFunctions,
} from '@shaderfrog/glsl-parser/dist/parser/utils';
import {
  visit,
  AstNode,
  NodeVisitors,
  Path,
} from '@shaderfrog/glsl-parser/dist/ast';
import { Engine, EngineContext } from './engine';
import {
  emptyShaderSections,
  findShaderSections,
  mergeShaderSections,
  ShaderSections,
} from '../ast/shader-sections';
import preprocess from '@shaderfrog/glsl-parser/dist/preprocessor';
import {
  convert300MainToReturn,
  from2To3,
  makeExpression,
  makeFnStatement,
} from '../ast/manipulate';
import { ensure } from '../util/ensure';
import { applyStrategy, Strategy } from './strategy';

export type ShaderStage = 'fragment' | 'vertex';

export enum NodeType {
  OUTPUT = 'output',
  BINARY = 'binary',
  SOURCE = 'source',
}

export type InputMapping = { [original: string]: string };
export type NodeConfig = {
  version: 2 | 3;
  preprocess: boolean;
  inputMapping?: InputMapping;
  strategies: Strategy[];
};

export interface CoreNode {
  id: string;
  name: string;
  type: string;
  config: NodeConfig;
  inputs: Array<Object>;
  outputs: Array<Object>;
  source: string;
  expressionOnly?: boolean;
  stage?: ShaderStage;
  biStage?: boolean;
  nextStageNodeId?: string;
  originalEngine?: string;
}

export interface BinaryNode extends CoreNode {
  operator: string;
}

export type GraphNode = CoreNode | BinaryNode;

export type Edge = {
  from: string;
  to: string;
  output: string;
  input: string;
  stage: ShaderStage;
};

export interface Graph {
  nodes: Array<GraphNode>;
  edges: Array<Edge>;
}

const alphabet = 'abcdefghijklmnopqrstuvwxyz';

export type NodeFiller = (node: GraphNode, ast: AstNode) => AstNode | void;
export const emptyFiller: NodeFiller = () => {};

export type NodeInputs = Record<string, (a: AstNode) => void>;

export const mapInputs = (
  mappings: InputMapping,
  inputs: NodeInputs
): NodeInputs =>
  Object.entries(inputs).reduce<NodeInputs>(
    (acc, [name, fn]) => ({
      ...acc,
      [mappings[name] || name]: fn,
    }),
    {}
  );

export const MAGIC_OUTPUT_STMTS = 'mainStmts';

export type NodeContext = {
  ast: AstNode | ParserProgram;
  source?: string;
  // Inputs are determined at parse time and should probably be in the graph,
  // not here on the runtime context for the node
  inputs?: NodeInputs;
  id?: string;
  name?: string;
};

export type OnBeforeCompile = (
  engineContext: EngineContext<any>,
  node: GraphNode
) => void;

export type ProduceAst = (
  engineContext: EngineContext<any>,
  engine: Engine<any>,
  graph: Graph,
  node: GraphNode,
  inputEdges: Edge[]
) => AstNode | ParserProgram;

export type FindInputs = (
  engineContext: EngineContext<any>,
  node: GraphNode,
  ast: AstNode,
  nodeContext: NodeContext,
  inputEdges: Edge[]
) => NodeInputs;

type CoreNodeParser<T> = {
  produceAst: ProduceAst;
  findInputs: FindInputs;
  produceFiller: NodeFiller;
};

export type ManipulateAst = (
  engineContext: EngineContext<any>,
  engine: Engine<any>,
  graph: Graph,
  node: GraphNode,
  ast: AstNode | ParserProgram,
  inputEdges: Edge[]
) => AstNode | ParserProgram;

export type NodeParser<T> = {
  onBeforeCompile?: OnBeforeCompile;
  manipulateAst?: ManipulateAst;
  findInputs?: FindInputs;
  produceFiller?: NodeFiller;
};

export const doesLinkThruShader = (graph: Graph, node: GraphNode): boolean => {
  const edges = graph.edges.filter((edge) => edge.from === node.id);
  if (edges.length === 0) {
    return false;
  }
  return edges.reduce<boolean>((foundShader, edge: Edge) => {
    const upstreamNode = ensure(
      graph.nodes.find((node) => node.id === edge.to)
    );
    return (
      foundShader ||
      // TODO: LARD this probably will intorduce some insidius hard to track
      // down bug, as I try to pull toon and phong up out of core, I need to
      // know if a graph links through a "shader" which now means somehting
      // different... does a config object need isShader? Can we compute it from
      // inputs/ outputs/source?
      (!upstreamNode.expressionOnly && upstreamNode.type !== NodeType.OUTPUT) ||
      doesLinkThruShader(graph, upstreamNode)
    );
  }, false);
};

type CoreParser<T> = { [key: string]: CoreNodeParser<T> };

export const nodeName = (node: GraphNode): string =>
  'main_' + node.name.replace(/[^a-zA-Z0-9]/g, ' ').replace(/ +/g, '_');

type Runtime = {};

export const mangleName = (name: string, node: GraphNode) => {
  // Mangle names by using the next stage id, if present
  const id = node.nextStageNodeId || node.id;
  return `${name}_${id}`;
};

export const mangle = (ast: AstNode, node: GraphNode, engine: Engine<any>) => {
  renameBindings(ast.scopes[0], (name) =>
    engine.preserve.has(name) ? name : mangleName(name, node)
  );
  renameFunctions(ast.scopes[0], (name) =>
    name === 'main' ? nodeName(node) : mangleName(name, node)
  );
};

export const coreParsers: CoreParser<Runtime> = {
  [NodeType.SOURCE]: {
    produceAst: (engineContext, engine, graph, node, inputEdges) => {
      const preprocessed = preprocess(node.source, {
        preserve: {
          version: () => true,
        },
      });

      const ast = parser.parse(preprocessed);

      if (node.config.version === 2 && node.stage) {
        from2To3(ast, node.stage);
      }

      // This assumes that expressionOnly nodes don't have a stage and that all
      // fragment source code shades have main function, which is probably wrong
      if (node.stage === 'fragment') {
        convert300MainToReturn('main', ast);
      }

      // Normalize names by using the next stage id, if present
      // const id = node.nextStageNodeId || node.id;
      // renameBindings(ast.scopes[0], (name) =>
      //   engine.preserve.has(name) ? name : `${name}_${id}`
      // );
      // renameFunctions(ast.scopes[0], (name) =>
      //   name === 'main' ? nodeName(node) : `${name}_${id}`
      // );

      return ast;
    },
    findInputs: (engineContext, node, ast) => {
      const inputs = node.config.strategies.reduce<NodeInputs>(
        (strategies, strategy) => ({
          ...strategies,
          ...applyStrategy(strategy, node, ast),
        }),
        {}
      );
      return inputs;
    },
    produceFiller: (node: GraphNode, ast) => {
      return node.expressionOnly
        ? ast.program
        : makeExpression(`${nodeName(node)}()`);
    },
  },
  // TODO: Output node assumes strategies are still passed in on node creation,
  // which might be a little awkward for graph creators?
  [NodeType.OUTPUT]: {
    produceAst: (engineContext, engine, graph, node, inputEdges) => {
      return parser.parse(node.source);
    },
    findInputs: (engineContext, node, ast) => {
      return node.config.strategies.reduce<NodeInputs>(
        (strategies, strategy) => {
          return {
            ...strategies,
            ...applyStrategy(strategy, node, ast),
          };
        },
        // Magic special input on output node only
        {
          [MAGIC_OUTPUT_STMTS]: (fillerAst: AstNode) => {
            ast.program
              .find((stmt: AstNode) => stmt.type === 'function')
              .body.statements.unshift(makeFnStatement(generate(fillerAst)));
          },
        }
      );
    },
    produceFiller: (node: GraphNode, ast) => {
      return makeExpression('impossible_call()');
    },
  },
  [NodeType.BINARY]: {
    produceAst: (engineContext, engine, graph, iNode, inputEdges) => {
      const node = iNode as BinaryNode;
      const fragmentAst: AstNode = {
        type: 'program',
        program: [
          makeExpression(
            '(' +
              (inputEdges.length
                ? inputEdges
                    .map((_, index) => alphabet.charAt(index))
                    .join(` ${node.operator} `)
                : `a ${node.operator} b`) +
              ')'
          ),
        ],
        scopes: [],
      };
      return fragmentAst;
    },
    findInputs: (engineContext, node, ast, nodeContext, inputEdges) => {
      return new Array(Math.max(inputEdges.length + 1, 2))
        .fill(0)
        .map((_, index) => alphabet.charAt(index))
        .reduce(
          (inputs, letter) => ({
            ...inputs,
            [letter]: (fillerAst: AstNode) => {
              let foundPath: Path | undefined;
              const visitors: NodeVisitors = {
                identifier: {
                  enter: (path) => {
                    if (path.node.identifier === letter) {
                      foundPath = path;
                    }
                  },
                },
              };
              visit(nodeContext.ast, visitors);
              if (!foundPath) {
                throw new Error(
                  `Im drunk and I think this case is impossible, no "${letter}" found in binary node?`
                );
              }

              if (foundPath.parent && foundPath.key) {
                foundPath.parent[foundPath.key] = fillerAst;
              } else {
                nodeContext.ast = fillerAst;
              }
            },
          }),
          {}
        );
    },
    produceFiller: (node: GraphNode, ast) => {
      return ast.program;
    },
  },
};

export const collectConnectedNodes = (
  graph: Graph,
  edges: Edge[],
  node: GraphNode,
  ids: NodeIds
): NodeIds => {
  let compiledIds = ids;

  const inputEdges = edges.filter((edge) => edge.to === node.id);
  if (inputEdges.length) {
    inputEdges.forEach((edge) => {
      const fromNode = ensure(
        graph.nodes.find((node) => edge.from === node.id),
        `GraphNode for edge ${edge.from} not found`
      );

      const childIds = collectConnectedNodes(graph, edges, fromNode, ids);
      compiledIds = { ...compiledIds, ...childIds };
    });

    return { ...compiledIds, [node.id]: node };
  } else {
    return { ...compiledIds, [node.id]: node };
  }
};

type NodeIds = Record<string, GraphNode>;
export type CompileNodeResult = [ShaderSections, AstNode | void, NodeIds];

export const compileNode = <T>(
  engine: Engine<T>,
  graph: Graph,
  edges: Edge[],
  engineContext: EngineContext<T>,
  // graphContext: GraphContext,
  node: GraphNode,
  stage: ShaderStage,
  ids: NodeIds
): CompileNodeResult => {
  // THIS DUPLICATES OTHER LINE
  const parser = {
    ...(coreParsers[node.type] || coreParsers[NodeType.SOURCE]),
    ...(engine.parsers[node.type] || {}),
  };

  const { onBeforeCompile } = parser;
  if (onBeforeCompile) {
    onBeforeCompile(engineContext, node);
  }
  // const parser = parsers[node.type];

  // Will I one day get good enough at typescript to be able to remove this
  // check? Or will I learn that I need it?
  if (!parser) {
    console.error(node);
    throw new Error(
      `No parser found for ${node.name} (${node.type}, id ${node.id})`
    );
  }

  const nodeContext = ensure(
    engineContext.nodes[node.id],
    `No node context found for "${node.name}" (id ${node.id})!`
  );
  const { ast, inputs } = nodeContext;
  let compiledIds = ids;

  const inputEdges = edges.filter((edge) => edge.to === node.id);
  if (inputEdges.length) {
    let continuation = emptyShaderSections();
    inputEdges.forEach((edge) => {
      const fromNode = ensure(
        graph.nodes.find((node) => edge.from === node.id),
        `GraphNode for edge ${edge.from} not found`
      );

      const [inputSections, fillerAst, childIds] = compileNode(
        engine,
        graph,
        edges,
        engineContext,
        // graphContext,
        fromNode,
        stage,
        ids
      );
      if (!fillerAst) {
        throw new Error(
          `Expected a filler ast from node ID ${fromNode.id} (${fromNode.type}) but none was returned`
        );
      }

      continuation = mergeShaderSections(continuation, inputSections);
      compiledIds = { ...compiledIds, ...childIds };

      if (!inputs) {
        throw new Error("I'm drunk and I think this case should be impossible");
      }
      if (!(edge.input in inputs)) {
        throw new Error(
          `GraphNode "${node.name}" has no input ${
            edge.input
          }!\nAvailable:${Object.keys(inputs).join(', ')}`
        );
      }
      inputs[edge.input](fillerAst);
      // console.log(generate(ast.program));
    });

    // Order matters here! *Prepend* the input nodes to this one, because
    // you have to declare functions in order of use in GLSL
    const sections = mergeShaderSections(
      continuation,
      // TODO: This and below "as" are bad
      node.expressionOnly
        ? emptyShaderSections()
        : findShaderSections(ast as ParserProgram)
    );

    return [
      sections,
      // (stage in parser ? parser[stage] : parser).produceFiller(node, ast),
      parser.produceFiller(node, ast),
      { ...compiledIds, [node.id]: node },
    ];
  } else {
    const sections = node.expressionOnly
      ? emptyShaderSections()
      : findShaderSections(ast as ParserProgram);

    return [
      sections,
      // (stage in parser ? parser[stage] : parser).produceFiller(node, ast),
      parser.produceFiller(node, ast),
      { ...compiledIds, [node.id]: node },
    ];
  }
};

const computeNodeContext = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph,
  node: GraphNode
): NodeContext => {
  // THIS DUPLICATES OTHER LINE
  const parser = {
    ...(coreParsers[node.type] || coreParsers[NodeType.SOURCE]),
    ...(engine.parsers[node.type] || {}),
  };

  const { onBeforeCompile, manipulateAst } = parser;
  if (onBeforeCompile) {
    onBeforeCompile(engineContext, node);
  }

  const inputEdges = graph.edges.filter((edge) => edge.to === node.id);

  // const ast = (stage in parser ? parser[stage] : parser).produceAst(
  let ast = parser.produceAst(engineContext, engine, graph, node, inputEdges);
  if (manipulateAst) {
    ast = manipulateAst(engineContext, engine, graph, node, ast, inputEdges);
  }

  const nodeContext: NodeContext = { ast, id: node.id, name: node.name };
  const inputs = parser.findInputs(
    engineContext,
    node,
    ast,
    nodeContext,
    inputEdges
  );
  nodeContext.inputs = node.config.inputMapping
    ? mapInputs(node.config.inputMapping, inputs)
    : inputs;

  // Tricky code warning: We only want to mangle the AST if this is a source
  // code node like "physical" or a user shader, and (probably?) not an
  // expression like "a + b" since those are local names;
  if (
    !node.expressionOnly &&
    node.type !== NodeType.BINARY &&
    node.type !== NodeType.OUTPUT
  ) {
    mangle(ast, node, engine);
  }

  return nodeContext;
};

const computeContextForNodes = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph,
  nodes: GraphNode[]
) =>
  nodes.reduce((context, node) => {
    console.log('computing context for', node.name);

    const nodeContext = computeNodeContext(
      engineContext,
      engine as Engine<Runtime>,
      graph,
      node
    );

    context[node.id] = {
      ...(context[node.id] || {}),
      ...nodeContext,
    };
    return context;
  }, engineContext.nodes);

export type CompileGraphResult = {
  fragment: ShaderSections;
  vertex: ShaderSections;
  activeNodeIds: Set<string>;
};

/**
 * Compute the context for every node in the graph, done on initial graph load
 * to compute the inputs/outputs for every node
 */
export const computeAllContexts = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph
) => {
  computeContextForNodes(engineContext, engine, graph, graph.nodes);
};

/**
 * Compute the contexts for nodes starting from the outputs, working backwards.
 * Used to only (re)-compute context for any actively used nodes
 */
export const computeGraphContext = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph
) => {
  const outputFrag = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'fragment'
  );
  if (!outputFrag) {
    throw new Error('No fragment output in graph');
  }
  const outputVert = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'vertex'
  );
  if (!outputVert) {
    throw new Error('No vertex output in graph');
  }

  const vertexIds = collectConnectedNodes(graph, graph.edges, outputVert, {});
  const fragmentIds = collectConnectedNodes(graph, graph.edges, outputFrag, {});
  const additionalIds = graph.nodes.filter(
    (node) =>
      node.stage === 'vertex' &&
      node.nextStageNodeId &&
      fragmentIds[node.nextStageNodeId] &&
      !vertexIds[node.id]
  );

  computeContextForNodes(engineContext, engine, graph, [
    outputFrag,
    ...Object.values(fragmentIds),
  ]);
  computeContextForNodes(engineContext, engine, graph, [
    outputVert,
    ...Object.values(vertexIds),
    ...additionalIds,
  ]);
  // computeSideContext(engineContext, engine, graph, 'fragment');
  // computeSideContext(engineContext, engine, graph, 'vertex');
};

export const compileGraph = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph
): CompileGraphResult => {
  computeGraphContext(engineContext, engine, graph);

  const outputFrag = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'fragment'
  );
  if (!outputFrag) {
    throw new Error('No fragment output in graph');
  }

  const [fragment, , fragmentIds] = compileNode(
    engine,
    graph,
    graph.edges,
    engineContext,
    outputFrag,
    'fragment',
    {}
  );

  const outputVert = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'vertex'
  );
  if (!outputVert) {
    throw new Error('No vertex output in graph');
  }

  const vertexIds = collectConnectedNodes(graph, graph.edges, outputVert, {});

  // Some fragment shaders reference vertex shaders which may not have been
  // given edges in the graph. Build invisible edges from these vertex nodes to
  // the hidden "mainStmts" input on the output node, which inlines the function
  // calls to those vertex main() statements and includes them in the output
  const orphanNodes = graph.nodes.filter(
    (node) =>
      node.stage === 'vertex' &&
      node.nextStageNodeId &&
      fragmentIds[node.nextStageNodeId] &&
      !vertexIds[node.id]
  );

  const orphanEdges: Edge[] = orphanNodes.map((node) => ({
    from: node.id,
    to: outputVert.id,
    output: 'main',
    input: MAGIC_OUTPUT_STMTS,
    stage: 'vertex',
  }));

  const [vertex, ,] = compileNode(
    engine,
    graph,
    [...graph.edges, ...orphanEdges],
    engineContext,
    outputVert,
    'vertex',
    {}
  );

  // Imperative hack :( to allow engines to know some unique id of compilation
  engineContext.compileCount++;

  // Every compileNode returns the AST so far, as well as the filler for the
  // next node with inputs. On the final step, we discard the filler
  return {
    fragment,
    vertex,
    activeNodeIds: new Set<string>([
      ...Object.keys(vertexIds),
      ...Object.keys(fragmentIds),
      ...orphanNodes.map((node) => node.id),
    ]),
  };
};