import { texture2DStrategy, uniformStrategy } from '../core/strategy';
import { sourceNode } from '../core/nodes/engine-node';

const solidColorNode = (id: string) =>
  sourceNode(
    id,
    'Solid Color',
    {
      version: 2,
      preprocess: true,
      strategies: [uniformStrategy(), texture2DStrategy()],
    },
    `precision highp float;
precision highp int;

uniform float blorf;

void main() {
    gl_FragColor = vec4(
        vec3(blorf),
        1.0
    );
}
    
`,
    'fragment',
    'three'
  );

export default solidColorNode;
