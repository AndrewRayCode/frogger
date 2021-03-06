import { useCallback, useEffect, useRef, useState, useContext } from 'react';
import * as BABYLON from 'babylonjs';
import { useHoisty } from '../../site/hoistedRefContext';

type SceneData = {
  lights: BABYLON.Node[];
  mesh?: BABYLON.Mesh;
};
type ScenePersistence = {
  sceneData: SceneData;
  canvas: HTMLCanvasElement;
  engine: BABYLON.Engine;
  scene: BABYLON.Scene;
  camera: BABYLON.ArcRotateCamera;
};

type Callback = (time: number) => void;

export const useBabylon = (callback: Callback) => {
  const { getRefData } = useHoisty();

  const { engine, camera, sceneData, canvas, scene } =
    getRefData<ScenePersistence>('babylon', () => {
      const canvas = document.createElement('canvas');
      const engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
      });
      const scene = new BABYLON.Scene(engine);
      return {
        sceneData: {
          lights: [],
        },
        canvas,
        engine,
        scene,
        camera: new BABYLON.ArcRotateCamera(
          'camera1',
          0,
          Math.PI,
          5,
          new BABYLON.Vector3(0, 0, 0),
          scene
        ),
        destroy: (data: ScenePersistence) => {
          console.log('👋🏻 Bye Bye Babylon!');
          data.scene.dispose();
          data.engine.dispose();
        },
      };
    });

  // const [babylonCanvas] = useState(() => document.createElement('canvas'));

  const [babylonDom, setBabylonDom] = useState<HTMLCanvasElement | null>(null);
  const babylonDomRef = useCallback((node) => setBabylonDom(node), []);

  const frameRef = useRef<number>(0);

  // const [engine] = useState(
  //   () =>
  //     new BABYLON.Engine(babylonCanvas, true, {
  //       preserveDrawingBuffer: true,
  //       stencil: true,
  //     })
  // );

  // const [scene] = useState(() => new BABYLON.Scene(engine));

  // const [camera] = useState(
  //   () =>
  //     new BABYLON.ArcRotateCamera(
  //       'camera1',
  //       0,
  //       Math.PI,
  //       5,
  //       new BABYLON.Vector3(0, 0, 0),
  //       scene
  //     )
  // );

  useEffect(() => {
    // Target the camera to scene origin
    camera.setTarget(BABYLON.Vector3.Zero());
    // Attach the camera to the canvas
    camera.attachControl(canvas, false);
  }, [scene, camera, canvas]);

  const savedCallback = useRef<Callback>(callback);
  // Remember the latest callback.
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (babylonDom && !babylonDom.childNodes.length) {
      console.log('Re-attaching Babylon DOM', canvas, 'to', babylonDom);
      babylonDom.appendChild(canvas);
    }
  }, [canvas, babylonDom]);

  const animate = useCallback(
    (time: number) => {
      scene.render();
      savedCallback.current(time);

      frameRef.current = requestAnimationFrame(animate);
    },
    [scene]
  );

  useEffect(() => {
    if (babylonDom) {
      console.log('🎬 Starting Babylon requestAnimationFrame');
      frameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      console.log('🛑 Cleaning up Babylon animationframe');
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
      // TODO: How to cleanup?
      // engine.dispose();
    };
  }, [engine, animate, babylonDom]);

  return { canvas, babylonDomRef, engine, scene, camera, sceneData };
};
