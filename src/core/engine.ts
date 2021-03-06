import { ParserProgram } from '@shaderfrog/glsl-parser/dist/parser/parser';
import { AstNode } from '@shaderfrog/glsl-parser/dist/ast';
import { MergeOptions } from '../ast/shader-sections';
import { Graph, NodeParser } from './graph';
import preprocess from '@shaderfrog/glsl-parser/dist/preprocessor';
import { generate, parser } from '@shaderfrog/glsl-parser';
import { ShaderStage, GraphNode, NodeType } from './graph';
import { NodeInput } from './nodes/core-node';

export enum EngineNodeType {
  output = 'output',
  toon = 'toon',
  phong = 'phong',
  physical = 'physical',
  shader = 'shader',
  binary = 'binary',
}

export interface Engine {
  name: string;
  preserve: Set<string>;
  mergeOptions: MergeOptions;
  // Component: FunctionComponent<{ engine: Engine; parsers: NodeParsers }>;
  // nodes: NodeParsers;
  parsers: Record<string, NodeParser>;
  importers: EngineImporters;
}

export type NodeContext = {
  ast: AstNode | ParserProgram;
  source?: string;
  // Inputs are determined at parse time and should probably be in the graph,
  // not here on the runtime context for the node
  inputs?: NodeInput[];
  id?: string;
  name?: string;
};

// The context an engine builds as it evaluates. It can manage its own state
// as the generic "RuntimeContext" which is passed to implemented engine methods
export type EngineContext = {
  engine: string;
  compileCount: 0;
  nodes: Record<string, NodeContext>;
  runtime: any;
  debuggingNonsense: {
    vertexSource?: string;
    vertexPreprocessed?: string;
    fragmentPreprocessed?: string;
    fragmentSource?: string;
  };
};

export type EngineImporter = {
  convertAst(ast: ParserProgram, type?: ShaderStage): void;
  edgeMap: { [oldInput: string]: string };
};
export type EngineImporters = {
  [engine: string]: EngineImporter;
};

type EdgeUpdates = { [edgeId: string]: { oldInput: string; newInput: string } };

export const convertToEngine = (
  oldEngine: Engine,
  newEngine: Engine,
  graph: Graph
): [Graph, EdgeUpdates] => {
  const converter = newEngine.importers[oldEngine.name];
  if (!converter) {
    throw new Error(
      `The engine ${newEngine.name} has no importer for ${oldEngine.name}`
    );
  }

  console.log(
    `Attempting to convert from ${newEngine.name} to ${oldEngine.name}`
  );

  const edgeUpdates: EdgeUpdates = {};

  graph.nodes.forEach((node) => {
    if (NodeType.SOURCE === node.type) {
      console.log(`Converting ${node.name} (${node.id})`);
      const preprocessed = preprocess(node.source, {
        preserveComments: true,
        preserve: {
          version: () => true,
          define: () => true,
        },
      });
      const ast = parser.parse(preprocessed);
      converter.convertAst(ast, node.stage);
      node.source = generate(ast);
    }

    graph.edges
      .filter((edge) => edge.to === node.id)
      .forEach((edge) => {
        if (edge.input in converter.edgeMap) {
          console.log(
            'converting',
            edge.input,
            'to',
            converter.edgeMap[edge.input]
          );
          edge.input = converter.edgeMap[edge.input];
          edgeUpdates[edge.input] = {
            oldInput: edge.input,
            newInput: converter.edgeMap[edge.input],
          };
        } else {
          console.log(edge.input, 'was not in ', converter.edgeMap);
        }
      });
  });
  return [graph, edgeUpdates];
};
