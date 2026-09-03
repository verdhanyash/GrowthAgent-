/**
 * web/src/components/Pipeline3D.tsx
 *
 * Performant, subtle Three.js 3D isometric pipeline visualization.
 * Stages are positioned along a 3D spline curve with data pulses moving
 * between nodes. Hover and click interactions select the real stage.
 */
import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import type { StageId } from "./PipelineGraph.js";
import type { AnalyticsResponse, TxListRow } from "@growthagent/shared";

interface Pipeline3DProps {
  analytics?: AnalyticsResponse;
  selectedTx?: TxListRow | null;
  selectedStage: StageId;
  onSelectStage: (stageId: StageId) => void;
}

interface StagePoint {
  id: StageId;
  label: string;
  sub: string;
  x: number;
  y: number;
  z: number;
  color: number;
}

const STAGES: StagePoint[] = [
  { id: "buyer", label: "Buyer Ingress", sub: "HTTP API", x: -14, y: 0, z: 0, color: 0x888888 },
  { id: "intake", label: "Intake & Tagger", sub: "Stage 1", x: -10, y: 0.5, z: 2, color: 0x666666 },
  { id: "context", label: "Evidence Pack", sub: "Stage 2", x: -6, y: -0.2, z: -1, color: 0x666666 },
  { id: "negotiation", label: "AI Negotiator", sub: "Stage 3", x: -2, y: 1.0, z: 2, color: 0xaaaaaa },
  { id: "citation", label: "Citation Auditor", sub: "Stage 4", x: 2, y: 0, z: -1, color: 0x666666 },
  { id: "gatekeeper", label: "Gatekeeper (16 Rules)", sub: "Authority", x: 6, y: 1.2, z: 1, color: 0xffffff },
  { id: "approvals", label: "Approvals Inbox", sub: "Human", x: 9, y: 3.5, z: 4, color: 0xfab219 },
  { id: "settlement", label: "Settlement Rail", sub: "Razorpay", x: 10, y: -1.5, z: -2, color: 0x0ca30c },
  { id: "audit", label: "Audit Hash Chain", sub: "SHA-256", x: 14, y: 0.5, z: 0, color: 0x4444ff },
];

export function Pipeline3D({
  selectedTx,
  selectedStage,
  onSelectStage,
}: Pipeline3DProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 560;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Camera: Isometric perspective
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 18, 28);
    camera.lookAt(0, 0, 0);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Subtle lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(10, 20, 15);
    scene.add(dirLight);

    // Subtle ground grid
    const gridHelper = new THREE.GridHelper(36, 36, 0x222222, 0x111111);
    gridHelper.position.y = -3;
    scene.add(gridHelper);

    // Stage meshes map for raycasting
    const stageMeshes: { mesh: THREE.Mesh; id: StageId }[] = [];
    const nodeGeometry = new THREE.BoxGeometry(2.4, 1.2, 2.4);

    STAGES.forEach((stage) => {
      const isSelected = stage.id === selectedStage;
      let nodeColor = stage.color;

      if (selectedTx) {
        if (selectedTx.outcome === "APPROVED" && (stage.id === "settlement" || stage.id === "audit")) {
          nodeColor = 0x0ca30c;
        } else if (selectedTx.outcome === "ESCALATED" && stage.id === "approvals") {
          nodeColor = 0xfab219;
        } else if (selectedTx.outcome === "DECLINED" && stage.id === "gatekeeper") {
          nodeColor = 0xd03b3b;
        }
      }

      const material = new THREE.MeshStandardMaterial({
        color: isSelected ? 0xffffff : nodeColor,
        roughness: 0.3,
        metalness: 0.8,
        emissive: isSelected ? 0x333333 : 0x000000,
      });

      const mesh = new THREE.Mesh(nodeGeometry, material);
      mesh.position.set(stage.x, stage.y, stage.z);
      scene.add(mesh);
      stageMeshes.push({ mesh, id: stage.id });

      // Add a subtle wireframe outline
      const wireframe = new THREE.LineSegments(
        new THREE.EdgesGeometry(nodeGeometry),
        new THREE.LineBasicMaterial({ color: isSelected ? 0xffffff : 0x444444 }),
      );
      mesh.add(wireframe);
    });

    // Connecting Curve
    const points = STAGES.filter((s) => s.id !== "approvals").map(
      (s) => new THREE.Vector3(s.x, s.y, s.z),
    );
    const curve = new THREE.CatmullRomCurve3(points);

    const tubeGeometry = new THREE.TubeGeometry(curve, 64, 0.08, 8, false);
    const tubeMaterial = new THREE.MeshBasicMaterial({ color: 0x262626 });
    const tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
    scene.add(tube);

    // Flowing pulse particle
    const particleGeometry = new THREE.SphereGeometry(0.24, 16, 16);
    const particleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const particle = new THREE.Mesh(particleGeometry, particleMaterial);
    scene.add(particle);

    // Raycaster for interactions
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerDown = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(stageMeshes.map((s) => s.mesh));

      if (intersects.length > 0) {
        const hit = stageMeshes.find((s) => s.mesh === intersects[0]?.object);
        if (hit) {
          onSelectStage(hit.id);
        }
      }
    };

    renderer.domElement.addEventListener("click", handlePointerDown);

    // Resize handler
    const handleResize = () => {
      if (!container) return;
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      renderer.setSize(newW, newH);
    };
    window.addEventListener("resize", handleResize);

    // Animation Loop
    let animId = 0;
    let t = 0;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      t = (t + 0.003) % 1;

      // Animate flowing particle along curve
      const pos = curve.getPoint(t);
      particle.position.copy(pos);

      // Gentle floating animation
      stageMeshes.forEach(({ mesh }, idx) => {
        mesh.position.y += Math.sin(Date.now() * 0.002 + idx) * 0.001;
      });

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handlePointerDown);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [selectedStage, selectedTx, onSelectStage]);

  return (
    <div className="relative h-[560px] w-full overflow-hidden rounded-xl border border-edge bg-canvas shadow-inner">
      <div ref={containerRef} className="h-full w-full cursor-grab active:cursor-grabbing" />
      <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-edge/80 bg-panel/80 px-2.5 py-1 text-[11px] text-mute backdrop-blur-sm">
        3D Isometric View · Click any 3D node block to inspect its telemetry
      </div>
    </div>
  );
}
