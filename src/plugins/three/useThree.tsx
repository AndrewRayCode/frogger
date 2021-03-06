import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { useCallback, useEffect, useRef, useState, useContext } from 'react';
import * as three from 'three';

import { useHoisty } from '../../site/hoistedRefContext';

type Callback = (time: number) => void;

type SceneData = {
  lights: three.Object3D[];
  mesh?: three.Mesh;
};
type ScenePersistence = {
  sceneData: SceneData;
  scene: three.Scene;
  camera: three.Camera;
  renderer: three.WebGLRenderer;
};

export const useThree = (callback: Callback) => {
  const { getRefData } = useHoisty();
  const { sceneData, scene, camera, renderer } = getRefData<ScenePersistence>(
    'three',
    () => {
      return {
        sceneData: {
          lights: [],
        },
        scene: new three.Scene(),
        camera: new three.PerspectiveCamera(75, 1 / 1, 0.1, 1000),
        renderer: new three.WebGLRenderer(),
        destroy: (data: ScenePersistence) => {
          console.log('👋🏻 Bye Bye Three.js!');
          data.renderer.forceContextLoss();
          // @ts-ignore
          data.renderer.domElement = null;
        },
      };
    }
  );

  const [threeDom, setThreeDom] = useState<HTMLDivElement | null>(null);
  const threeDomRef = useCallback((node) => setThreeDom(node), []);

  const frameRef = useRef<number>(0);
  const controlsRef = useRef<OrbitControls>();

  useEffect(() => {
    if (!scene.children.find((child: any) => child === camera)) {
      camera.position.set(0, 0, 3);
      camera.lookAt(0, 0, 0);
      scene.add(camera);
    }
  }, [scene, camera]);

  const savedCallback = useRef<Callback>(callback);
  // Remember the latest callback.
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (threeDom && !threeDom.childNodes.length) {
      console.log(
        'Re-attaching three.js DOM and instantiate OrbitControls, appendingx',
        renderer.domElement,
        'to',
        threeDom
      );
      threeDom.appendChild(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.update();
      controlsRef.current = controls;
    }
  }, [camera, renderer, threeDom]);

  const animate = useCallback(
    (time: number) => {
      if (controlsRef.current) {
        controlsRef.current.update();
      }
      renderer.render(scene, camera);
      savedCallback.current(time);

      frameRef.current = requestAnimationFrame(animate);
    },
    [camera, renderer, scene]
  );

  useEffect(() => {
    if (threeDom) {
      console.log('🎬 Starting requestAnimationFrame');
      frameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      console.log('🛑 Cleaning up Three animationframe');
      if (controlsRef.current) {
        controlsRef.current.dispose();
      }
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [animate, threeDom]);

  return { sceneData, threeDomRef, scene, camera, renderer };
};
