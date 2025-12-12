import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type, Schema } from "@google/genai";

// --- Types & Constants ---

type Point = { x: number; y: number };
type ToolType = "SELECT" | "WALL" | "DOOR" | "WINDOW" | "TEXT" | "CIRCLE" | "RECT" | "DIMENSION" | "POLYLINE" | "ARC" | "INSERT_BLOCK" | "LEADER" | "TABLE" | "CENTERMARK";
type EntityType = "wall" | "door" | "window" | "text" | "dimension" | "circle" | "rect" | "polyline" | "arc" | "image" | "insert" | "leader" | "table" | "centermark";

interface Entity {
  id: string;
  type: EntityType;
  selected?: boolean;
  layer?: string;
  [key: string]: any;
}

interface Wall extends Entity {
  type: "wall";
  start: Point;
  end: Point;
  thickness: number;
}

interface PolylineEntity extends Entity {
  type: "polyline";
  points: Point[];
  closed: boolean;
}

interface ArcEntity extends Entity {
  type: "arc";
  p1: Point; // Start
  p2: Point; // Middle (Point on arc)
  p3: Point; // End
}

interface CircleEntity extends Entity {
  type: "circle";
  center: Point;
  radius: number;
}

interface RectEntity extends Entity {
  type: "rect";
  start: Point;
  width: number;
  height: number;
}

interface Door extends Entity {
  type: "door";
  x: number;
  y: number;
  width: number;
  rotation: number;
}

interface TextLabel extends Entity {
  type: "text";
  x: number;
  y: number;
  content: string;
  fontSize: number;
}

interface Dimension extends Entity {
  type: "dimension";
  start: Point;
  end: Point;
}

interface ImageEntity extends Entity {
    type: "image";
    href: string;
    x: number;
    y: number;
    width: number;
    height: number;
    opacity: number;
}

interface BlockDefinition {
    name: string;
    entities: Entity[];
    basePoint: Point;
}

interface InsertEntity extends Entity {
    type: "insert";
    blockName: string;
    insertPoint: Point;
    scale: number;
    rotation: number;
}

// --- New Annotation Types ---

interface LeaderEntity extends Entity {
    type: "leader";
    start: Point; // Arrow tip
    end: Point;   // Text location
    text: string;
}

interface TableEntity extends Entity {
    type: "table";
    x: number;
    y: number;
    rows: number;
    cols: number;
    rowHeight: number;
    colWidth: number;
}

interface CenterMarkEntity extends Entity {
    type: "centermark";
    center: Point;
    size: number;
}

interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

interface ChatMessage {
  role: "user" | "model";
  text: string;
  attachment?: {
    name: string;
    mimeType: string;
  };
}

const COLORS = {
  bg: "#212121", 
  ribbonBg: "#2b2b2b",
  panelBg: "#252526",
  grid: "#333",
  gridMajor: "#444",
  wall: "#dcdcdc",
  wallSelected: "#007fd4",
  door: "#ffd700",
  text: "#ffffff",
  dim: "#aaaaaa",
  uiBorder: "#3e3e42",
  accent: "#007fd4",
  ribbonText: "#f0f0f0",
  ribbonLabel: "#aaaaaa"
};

// --- Helper Functions ---

const generateId = () => Math.random().toString(36).substr(2, 9);
const dist = (p1: Point, p2: Point) => Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));

const screenToWorld = (screen: Point, view: ViewState): Point => ({
  x: (screen.x - view.x) / view.zoom,
  y: (screen.y - view.y) / view.zoom,
});

const getArcPath = (p1: Point, p2: Point, p3: Point) => {
    if (!p1 || !p2 || !p3) return "";
    const x1 = p1.x, y1 = p1.y;
    const x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y;

    const D = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if (Math.abs(D) < 0.001) return `M ${x1} ${y1} L ${x3} ${y3}`;

    const Ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / D;
    const Uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / D;
    
    const center = { x: Ux, y: Uy };
    const radius = Math.sqrt(Math.pow(x1 - Ux, 2) + Math.pow(y1 - Uy, 2));

    const cp = (x2-x1)*(y3-y1) - (y2-y1)*(x3-x1);
    const sweep = cp > 0 ? 0 : 1; 

    return `M ${x1} ${y1} A ${radius} ${radius} 0 0 ${sweep} ${x3} ${y3}`;
};

const getLineIntersection = (p1: Point, p2: Point, p3: Point, p4: Point): Point | null => {
    const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (d === 0) return null;
    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
    return {
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y)
    };
};


// --- Icons ---
const Icons = {
  Line: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="2" fill="currentColor"/><circle cx="20" cy="4" r="2" fill="currentColor"/></svg>,
  Polyline: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 21 9 5 15 15 21 3"/></svg>,
  Circle: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>,
  Arc: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20 A 18 18 0 0 1 20 4"/></svg>,
  Rect: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16"/></svg>,
  Door: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 21V3h2v18"/><path d="M8 21h10v-9a9 9 0 0 0-9-9h-1"/></svg>,
  
  // Modify
  Move: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M19 9l3 3-3 3"/><path d="M9 19l3 3 3-3"/><path d="M2 12h20"/><path d="M12 2v20"/></svg>,
  Rotate: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12A10 10 0 0 0 12 2v10z"/><path d="M12 12L2.06 13.5a10 10 0 0 0 8.4 8.4z"/></svg>,
  Trim: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 3L3 21"/><circle cx="12" cy="12" r="5" strokeDasharray="2 2"/></svg>, // Using as Delete
  Copy: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  Mirror: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20"/><path d="M18 6l-6 5 6 5V6z"/><path d="M6 16l6-5-6-5v10z"/></svg>,
  Fillet: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21h8a8 8 0 0 0 8-8V3"/></svg>,
  
  // Annotation
  Text: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M8 20h8"/></svg>,
  Dimension: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 21l-4.5-4.5"/><path d="M3 21l4.5-4.5"/><path d="M7.5 16.5l9 0"/><path d="M21 3v5"/><path d="M3 3v5"/><path d="M3 5h18"/><path d="M12 2v3"/></svg>,
  MText: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z"/><path d="M6 8h12M6 12h8M6 16h10"/></svg>,
  CenterMark: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>,
  Leader: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 7l5 5 8 0"/><path d="M7 7l2 2"/></svg>,
  Table: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>,

  // Parametric
  AutoConstrain: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/><path d="M10 10l4 4" strokeDasharray="2 2"/></svg>,
  LinearDim: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12h20"/><line x1="2" y1="8" x2="2" y2="16"/><line x1="22" y1="8" x2="22" y2="16"/></svg>,
  Lock: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  Coincident: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="8" cy="12" r="3"/><circle cx="16" cy="12" r="3"/><path d="M11 12h2"/></svg>,
  Parallel: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="20" x2="16" y2="4"/><line x1="8" y1="20" x2="20" y2="4"/></svg>,
  Tangent: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8"/><line x1="4" y1="20" x2="20" y2="20"/></svg>,

  // View
  UCS: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="2"/></svg>,
  ViewCube: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="6" width="12" height="12"/><path d="M6 6l4-4h8l4 4v8l-4 4H10L6 18z"/></svg>,
  SheetSet: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z"/><path d="M14 4v16"/></svg>,
  ZoomExtents: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M8 8h6v6H8z"/></svg>,
  ZoomOriginal: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12h6M12 9v6"/></svg>,

  // Manage
  Record: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="6" fill="red" stroke="none"/></svg>,
  CUI: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>,
  Purge: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,

  // Output
  Plot: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>,
  Export: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><polyline points="7 11 12 16 17 11"/><line x1="12" y1="4" x2="12" y2="16"/></svg>,

  // Collaborate
  Share: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>,
  Compare: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="10" height="14" opacity="0.5"/><rect x="12" y="7" width="10" height="14"/></svg>,

  // Express Tools
  ArcText: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 18a14 14 0 0 1 16 0"/><text x="12" y="14" fontSize="8" textAnchor="middle" fill="currentColor">T</text></svg>,
  BreakLine: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12h4l2-4 4 8 2-4h4"/></svg>,

  // Insert Tab Icons
  InsertBlock: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h10v10h-10z" /><circle cx="18" cy="18" r="3"/></svg>,
  EditAttribute: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  CreateBlock: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="14" height="14" /><path d="M19 13v6h-6"/><path d="M16 16l5 5"/><path d="M21 16l-5 5"/></svg>,
  DefineAttribute: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12h6"/><path d="M12 9v6"/></svg>,
  Attach: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  Clip: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" strokeDasharray="4 2"/></svg>,
  Adjust: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 2v20"/><path d="M2 12h20"/></svg>,
  PDFImport: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  Field: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z"/><path d="M8 12h8"/></svg>,
  DataLink: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  Location: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"/></svg>,

  // App
  Cursor: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>,
  Send: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  Cpu: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>,
  Paperclip: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  Close: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
};

// --- Sub-Components ---

const RibbonButton = ({ icon: Icon, label, onClick, active, big, disabled }: { icon: any, label: string, onClick?: () => void, active?: boolean, big?: boolean, disabled?: boolean }) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        flexDirection: big ? "column" : "row",
        alignItems: "center",
        justifyContent: big ? "center" : "flex-start",
        gap: big ? "4px" : "8px",
        padding: big ? "4px 8px" : "4px 6px",
        height: big ? "50px" : "24px",
        width: big ? "auto" : "100%",
        minWidth: big ? "50px" : "auto",
        background: active ? "#3e4f5e" : "transparent",
        border: active ? "1px solid #5a7085" : "1px solid transparent",
        borderRadius: "2px",
        color: disabled ? "#666" : COLORS.ribbonText,
        fontSize: "11px",
        cursor: disabled ? "default" : "pointer",
        outline: "none"
      }}
    >
      <div style={{ color: active ? "#61dafb" : "inherit" }}><Icon /></div>
      <span>{label}</span>
    </button>
  );
};

// --- Main Application ---

const App = () => {
  // --- State ---
  const [entities, setEntities] = useState<Entity[]>([]);
  const [blockDefs, setBlockDefs] = useState<Record<string, BlockDefinition>>({});
  const [activeBlockName, setActiveBlockName] = useState<string | null>(null);

  const [view, setView] = useState<ViewState>({ x: 0, y: 0, zoom: 1 });
  const [activeTool, setActiveTool] = useState<ToolType>("SELECT");
  const [activeTab, setActiveTab] = useState<string>("Home");
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [drawingStart, setDrawingStart] = useState<Point | null>(null);
  const [tempPoints, setTempPoints] = useState<Point[]>([]); // For Polyline/Arc
  const [mousePos, setMousePos] = useState<Point>({ x: 0, y: 0 });
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
    { role: "model", text: "Ready. I can help you draw plans. Try 'Draw a 500x400 room' or 'Add a door'." }
  ]);
  const [userInput, setUserInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  
  // File Upload State
  const [pendingFile, setPendingFile] = useState<{data: string, mimeType: string, name: string} | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const canvasRef = useRef<HTMLDivElement>(null);

  // --- AI ---
  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.API_KEY || "" }), []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      const base64Data = base64String.split(',')[1];
      
      setPendingFile({
        data: base64Data,
        mimeType: file.type,
        name: file.name
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleAttachImage = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
          const img = new Image();
          img.onload = () => {
              const newImg: ImageEntity = {
                  id: generateId(),
                  type: 'image',
                  href: img.src,
                  x: (view.x * -1 + 100)/view.zoom, // Rough center
                  y: (view.y * -1 + 100)/view.zoom,
                  width: img.width,
                  height: img.height,
                  opacity: 0.5
              };
              setEntities(prev => [...prev, newImg]);
          };
          img.src = evt.target?.result as string;
      };
      reader.readAsDataURL(file);
      e.target.value = "";
  };

  const createBlock = () => {
      const selected = entities.filter(e => e.selected);
      if (selected.length === 0) {
          alert("Select objects to create a block.");
          return;
      }
      const name = prompt("Enter block name:");
      if (!name) return;
      if (blockDefs[name]) {
          alert("Block name already exists.");
          return;
      }

      // Calculate center of selection for base point
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      selected.forEach(e => {
          const check = (x:number, y:number) => {
              if(x<minX)minX=x; if(x>maxX)maxX=x;
              if(y<minY)minY=y; if(y>maxY)maxY=y;
          };
          // Simplified bounds check (start points mostly)
          if(e.start) check(e.start.x, e.start.y);
          if(e.center) check(e.center.x, e.center.y);
          if(e.points) e.points.forEach((p:Point) => check(p.x, p.y));
          if(e.x !== undefined) check(e.x, e.y);
      });
      const basePoint = { x: (minX+maxX)/2, y: (minY+maxY)/2 };
      if (!isFinite(basePoint.x)) { basePoint.x = 0; basePoint.y = 0; }

      // Normalize entities to base point
      const normalizedEntities = selected.map(ent => {
          const clone = JSON.parse(JSON.stringify(ent));
          delete clone.id; 
          delete clone.selected;
          // Shift coordinates
          const shift = (v: number, base: number) => v - base;
          if(clone.start) { clone.start.x = shift(clone.start.x, basePoint.x); clone.start.y = shift(clone.start.y, basePoint.y); }
          if(clone.end) { clone.end.x = shift(clone.end.x, basePoint.x); clone.end.y = shift(clone.end.y, basePoint.y); }
          if(clone.center) { clone.center.x = shift(clone.center.x, basePoint.x); clone.center.y = shift(clone.center.y, basePoint.y); }
          if(clone.points) clone.points = clone.points.map((p:Point) => ({x: shift(p.x, basePoint.x), y: shift(p.y, basePoint.y)}));
          if(clone.x !== undefined) { clone.x = shift(clone.x, basePoint.x); clone.y = shift(clone.y, basePoint.y); }
          if(clone.p1) {
              ['p1','p2','p3'].forEach(k => {
                  clone[k].x = shift(clone[k].x, basePoint.x);
                  clone[k].y = shift(clone[k].y, basePoint.y);
              });
          }
          return clone;
      });

      setBlockDefs(prev => ({ ...prev, [name]: { name, entities: normalizedEntities, basePoint } }));
      
      // Replace selection with block instance
      const newInstance: InsertEntity = {
          id: generateId(),
          type: 'insert',
          blockName: name,
          insertPoint: basePoint,
          scale: 1,
          rotation: 0,
          selected: true
      };
      
      setEntities(prev => [...prev.filter(e => !e.selected), newInstance]);
  };

  const insertBlock = () => {
      const names = Object.keys(blockDefs);
      if (names.length === 0) {
          alert("No blocks defined.");
          return;
      }
      const name = prompt(`Enter block name to insert (${names.join(", ")}):`);
      if (name && blockDefs[name]) {
          setActiveBlockName(name);
          setActiveTool("INSERT_BLOCK");
      } else if (name) {
          alert("Block not found.");
      }
  };

  const zoomExtents = () => {
      if (entities.length === 0) {
          setView({ x: 0, y: 0, zoom: 1 });
          return;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const check = (x:number, y:number) => {
          if(x<minX)minX=x; if(x>maxX)maxX=x;
          if(y<minY)minY=y; if(y>maxY)maxY=y;
      };
      entities.forEach(e => {
          if((e as any).start) { check((e as any).start.x, (e as any).start.y); check((e as any).end?.x??(e as any).start.x, (e as any).end?.y??(e as any).start.y); }
          if((e as any).center) { check((e as any).center.x, (e as any).center.y); }
          if((e as any).x !== undefined) { check((e as any).x, (e as any).y); }
          if((e as any).points) { (e as any).points.forEach((p:Point) => check(p.x, p.y)); }
      });
      if (!isFinite(minX)) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const padding = 50;
      const w = maxX - minX;
      const h = maxY - minY;
      const scaleX = (rect.width - padding * 2) / w;
      const scaleY = (rect.height - padding * 2) / h;
      const zoom = Math.min(scaleX, scaleY, 5); // Max zoom cap
      
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      
      setView({
          x: rect.width / 2 - cx * zoom,
          y: rect.height / 2 - cy * zoom,
          zoom
      });
  };

  const resetView = () => setView({ x: 0, y: 0, zoom: 1 });

  const purge = () => {
      if (confirm("Are you sure you want to delete all entities?")) {
          setEntities([]);
      }
  };

  const exportJSON = () => {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(entities, null, 2));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", "drawing.json");
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
  };

  const callAI = async () => {
    if (!userInput.trim() && !pendingFile) return;
    
    const newMsg: ChatMessage = { 
        role: "user", 
        text: userInput,
        attachment: pendingFile ? { name: pendingFile.name, mimeType: pendingFile.mimeType } : undefined
    };

    const newHistory = [...chatHistory, newMsg];
    setChatHistory(newHistory);
    
    const currentFile = pendingFile;
    setPendingFile(null);
    setUserInput("");
    setIsLoading(true);

    try {
      const context = JSON.stringify(entities.map(({ selected, layer, ...rest }) => rest));
      
      const systemPrompt = `
      You are an expert AutoCAD operator and architectural assistant.
      CURRENT DRAWING CONTEXT (JSON): ${context}
      
      Your goal is to execute the user's architectural commands by generating a JSON response containing a list of actions.
      
      AVAILABLE ACTIONS: create, update, delete, clear.
      
      EXAMPLE RESPONSE:
      {
        "message": "I've drawn the living room.",
        "actions": [
           { "action": "create", "type": "rect", "start": {"x": 100, "y": 100}, "width": 400, "height": 300 }
        ]
      }
      `;

      const parts: any[] = [];
      if (currentFile) parts.push({ inlineData: { mimeType: currentFile.mimeType, data: currentFile.data } });
      if (newMsg.text) parts.push({ text: newMsg.text });

      const result = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts }],
        config: { 
            responseMimeType: "application/json",
            systemInstruction: systemPrompt
        }
      });

      const responseText = result.text;
      if (responseText) {
        const responseData = JSON.parse(responseText);
        if (responseData.actions) {
          setEntities(prevEntities => {
              let currentEntities = [...prevEntities];
              responseData.actions.forEach((act: any) => {
                const action = act.action?.toLowerCase();
                const type = act.type?.toLowerCase();

                if (action === "clear") currentEntities = [];
                else if (action === "create") {
                    const newEntity = { ...act, id: generateId(), type, action: undefined };
                    if (type === 'wall' && (!newEntity.start || !newEntity.end)) return;
                    if (type === 'rect' && (!newEntity.start || !newEntity.width)) return;
                    if (type === 'circle' && (!newEntity.center || !newEntity.radius)) return;
                    currentEntities.push(newEntity); 
                } else if (action === "delete") {
                    currentEntities = currentEntities.filter(e => e.id !== act.id);
                } else if (action === "update") {
                    currentEntities = currentEntities.map(e => e.id === act.id ? { ...e, ...act, action: undefined } : e);
                }
              });
              return currentEntities;
          });
        }
        setChatHistory(prev => [...prev, { role: "model", text: responseData.message || "Done." }]);
      }
    } catch (e) {
      console.error(e);
      setChatHistory(prev => [...prev, { role: "model", text: "Error processing request. Please try again." }]);
    } finally {
      setIsLoading(false);
    }
  };

  // --- Canvas Logic ---

  // Keyboard shortcuts
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
              setEntities(prev => prev.filter(e => !e.selected));
          }
          if (e.key === 'Enter') {
              if (activeTool === 'POLYLINE' && tempPoints.length > 1) {
                  const newPoly: PolylineEntity = {
                      id: generateId(), type: 'polyline', points: tempPoints, closed: false
                  };
                  setEntities(prev => [...prev, newPoly]);
                  setTempPoints([]);
              }
          }
          if (e.key === 'Escape') {
              setTempPoints([]);
              setDrawingStart(null);
              setActiveTool('SELECT');
              setActiveBlockName(null);
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTool, tempPoints]);

  const handleWheel = (e: React.WheelEvent) => {
    const scaleBy = 1.1;
    const oldZoom = view.zoom;
    const newZoom = e.deltaY > 0 ? oldZoom / scaleBy : oldZoom * scaleBy;
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = (mx - view.x) / oldZoom;
    const wy = (my - view.y) / oldZoom;
    setView({ x: mx - wx * newZoom, y: my - wy * newZoom, zoom: newZoom });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      if (activeTool === 'POLYLINE' && tempPoints.length > 1) {
          const newPoly: PolylineEntity = {
              id: generateId(), type: 'polyline', points: tempPoints, closed: false
          };
          setEntities(prev => [...prev, newPoly]);
          setTempPoints([]);
      } else {
          setDrawingStart(null);
          setTempPoints([]);
          setActiveTool('SELECT');
          setActiveBlockName(null);
      }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldPos = screenToWorld({ x: mx, y: my }, view);

    if (e.button === 1 || activeTool === "SELECT") {
        setIsDragging(true);
        setDragStart({ x: mx, y: my }); 

        if (activeTool === "SELECT") {
            const hit = entities.find(ent => {
               if (ent.type === 'wall' || ent.type === 'dimension' || ent.type === 'leader') {
                   const w = ent as Wall;
                   const s = ent.type==='leader' ? (ent as any).start : ent.start;
                   const en = ent.type==='leader' ? (ent as any).end : ent.end;
                   if (!s || !en) return false;
                   const l2 = Math.pow(en.x - s.x, 2) + Math.pow(en.y - s.y, 2);
                   if (l2 === 0) return dist(worldPos, s) < 10;
                   let t = ((worldPos.x - s.x) * (en.x - s.x) + (worldPos.y - s.y) * (en.y - s.y)) / l2;
                   t = Math.max(0, Math.min(1, t));
                   const proj = { x: s.x + t * (en.x - s.x), y: s.y + t * (en.y - s.y) };
                   return dist(worldPos, proj) < 8;
               }
               if (ent.type === 'rect' || ent.type === 'image' || ent.type === 'table') {
                   const w = (ent as any).width || (ent as any).colWidth * (ent as any).cols;
                   const h = (ent as any).height || (ent as any).rowHeight * (ent as any).rows;
                   const x = (ent as any).x !== undefined ? (ent as any).x : (ent as any).start?.x;
                   const y = (ent as any).y !== undefined ? (ent as any).y : (ent as any).start?.y;
                   if (x === undefined || y === undefined) return false;
                   return worldPos.x >= x && worldPos.x <= x + w && worldPos.y >= y && worldPos.y <= y + h;
               }
               if (ent.type === 'circle' || ent.type === 'centermark') {
                   const c = (ent as any).center; 
                   const r = (ent as any).radius || (ent as any).size;
                   if (!c) return false;
                   return Math.abs(dist(worldPos, c) - r) < 5 || (ent.type === 'centermark' && dist(worldPos, c) < 10);
               }
               if (ent.type === 'text') { return Math.abs(worldPos.x - ent.x) < 20 && Math.abs(worldPos.y - ent.y) < 10; }
               if (ent.type === 'polyline') {
                   const p = ent as PolylineEntity;
                   if (!p.points || p.points.length === 0) return false;
                   const minX = Math.min(...p.points.map(pt=>pt.x));
                   const maxX = Math.max(...p.points.map(pt=>pt.x));
                   const minY = Math.min(...p.points.map(pt=>pt.y));
                   const maxY = Math.max(...p.points.map(pt=>pt.y));
                   return worldPos.x >= minX && worldPos.x <= maxX && worldPos.y >= minY && worldPos.y <= maxY;
               }
               if (ent.type === 'arc') {
                   const a = ent as ArcEntity;
                   return dist(worldPos, a.p1) < 10 || dist(worldPos, a.p2) < 10 || dist(worldPos, a.p3) < 10;
               }
               if (ent.type === 'insert') {
                   return dist(worldPos, (ent as InsertEntity).insertPoint) < 15;
               }
               return false;
            });
            
            if (e.ctrlKey) {
                 if (hit) setEntities(prev => prev.map(en => en.id === hit.id ? { ...en, selected: !en.selected } : en));
            } else {
                 setEntities(prev => prev.map(en => ({ ...en, selected: hit ? en.id === hit.id : false })));
            }
        }
    } else {
        if (activeTool === 'POLYLINE') {
            setTempPoints(prev => [...prev, worldPos]);
        } else if (activeTool === 'ARC') {
            const nextPoints = [...tempPoints, worldPos];
            if (nextPoints.length === 2) {
                 const newArc: ArcEntity = {
                     id: generateId(), type: 'arc', p1: nextPoints[0], p2: nextPoints[1], p3: worldPos
                 };
                 setEntities(prev => [...prev, newArc]);
                 setTempPoints([]); 
            } else {
                 setTempPoints(nextPoints);
            }
        } else if (activeTool === 'INSERT_BLOCK') {
            if (activeBlockName) {
                const newInsert: InsertEntity = {
                    id: generateId(), type: 'insert', blockName: activeBlockName, insertPoint: worldPos, scale: 1, rotation: 0
                };
                setEntities(prev => [...prev, newInsert]);
            }
        } else if (activeTool === 'CENTERMARK') {
             const hit = entities.find(ent => (ent.type === 'circle' || ent.type === 'arc') && !ent.selected);
             if (hit) {
                 let center: Point | null = null;
                 let size = 20;
                 if (hit.type === 'circle') { center = (hit as CircleEntity).center; size = (hit as CircleEntity).radius * 1.2; }
                 else if (hit.type === 'arc') {
                     const a = hit as ArcEntity;
                     const x1=a.p1.x,y1=a.p1.y, x2=a.p2.x,y2=a.p2.y, x3=a.p3.x,y3=a.p3.y;
                     const D = 2*(x1*(y2-y3)+x2*(y3-y1)+x3*(y1-y2));
                     if (Math.abs(D)>0.001) {
                         const Ux = ((x1*x1+y1*y1)*(y2-y3)+(x2*x2+y2*y2)*(y3-y1)+(x3*x3+y3*y3)*(y1-y2))/D;
                         const Uy = ((x1*x1+y1*y1)*(x3-x2)+(x2*x2+y2*y2)*(x1-x3)+(x3*x3+y3*y3)*(x2-x1))/D;
                         center = {x: Ux, y: Uy};
                         size = Math.sqrt((x1-Ux)**2 + (y1-Uy)**2) * 1.2;
                     }
                 }
                 if (center) {
                     setEntities(prev => [...prev, { id: generateId(), type: 'centermark', center, size } as CenterMarkEntity]);
                 }
             }
        } else if (activeTool === 'TABLE') {
             const spec = prompt("Enter rows,columns (e.g. 4,3):", "4,3");
             if (spec) {
                 const [r, c] = spec.split(',').map(n => parseInt(n));
                 if (r && c) {
                     setEntities(prev => [...prev, { id: generateId(), type: 'table', x: worldPos.x, y: worldPos.y, rows: r, cols: c, rowHeight: 20, colWidth: 60 } as TableEntity]);
                     setActiveTool('SELECT');
                 }
             }
        } else {
            setDrawingStart(worldPos);
            if (activeTool === 'TEXT') {
                const content = prompt("Enter text content:", "Text");
                if (content) {
                    const newText: TextLabel = {
                        id: generateId(), type: 'text', x: worldPos.x, y: worldPos.y, content, fontSize: 12
                    };
                    setEntities(prev => [...prev, newText]);
                    setActiveTool('SELECT'); 
                    setDrawingStart(null);
                }
            } else if (activeTool === 'DOOR') {
                const newDoor: Door = {
                    id: generateId(), type: 'door', x: worldPos.x, y: worldPos.y, width: 40, rotation: 0
                };
                setEntities(prev => [...prev, newDoor]);
                setDrawingStart(null);
            }
        }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldPos = screenToWorld({ x: mx, y: my }, view);
    setMousePos(worldPos);

    if (isDragging && dragStart && activeTool === "SELECT") {
        const dx = mx - dragStart.x;
        const dy = my - dragStart.y;
        
        const hasSelection = entities.some(e => e.selected);
        if (e.buttons === 4 || (e.buttons === 1 && !hasSelection)) {
             setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
             setDragStart({ x: mx, y: my });
        } else if (e.buttons === 1 && hasSelection) {
             const wDx = dx / view.zoom;
             const wDy = dy / view.zoom;
             setEntities(prev => prev.map(ent => {
                 if (!ent.selected) return ent;
                 if (ent.type === 'wall' || ent.type === 'dimension' || ent.type === 'leader') {
                     const s = (ent as any).start;
                     const en = (ent as any).end;
                     return { ...ent, start: { x: s.x + wDx, y: s.y + wDy }, end: { x: en.x + wDx, y: en.y + wDy } };
                 } else if (ent.type === 'rect') {
                     return { ...ent, start: { x: ent.start.x + wDx, y: ent.start.y + wDy } };
                 } else if (ent.type === 'circle' || ent.type === 'centermark') {
                     return { ...ent, center: { x: (ent as any).center.x + wDx, y: (ent as any).center.y + wDy } };
                 } else if (ent.type === 'polyline') {
                     return { ...ent, points: ent.points.map(p => ({ x: p.x + wDx, y: p.y + wDy })) };
                 } else if (ent.type === 'arc') {
                     return { ...ent, p1: {x: ent.p1.x+wDx, y: ent.p1.y+wDy}, p2: {x: ent.p2.x+wDx, y: ent.p2.y+wDy}, p3: {x: ent.p3.x+wDx, y: ent.p3.y+wDy} };
                 } else if (ent.type === 'insert') {
                     return { ...ent, insertPoint: { x: ent.insertPoint.x + wDx, y: ent.insertPoint.y + wDy } };
                 } else {
                     return { ...ent, x: ent.x + wDx, y: ent.y + wDy };
                 }
             }));
             setDragStart({ x: mx, y: my }); 
        }
    }
  };

  const handleMouseUp = () => {
    if (activeTool !== 'SELECT' && activeTool !== 'TEXT' && activeTool !== 'DOOR' && activeTool !== 'POLYLINE' && activeTool !== 'ARC' && activeTool !== 'INSERT_BLOCK' && activeTool !== 'TABLE' && activeTool !== 'CENTERMARK' && drawingStart) {
        if (activeTool === 'WALL') {
            const newWall: Wall = { id: generateId(), type: 'wall', start: drawingStart, end: mousePos, thickness: 5 };
            if (Math.abs(newWall.start.x - newWall.end.x) < 10) newWall.end.x = newWall.start.x;
            if (Math.abs(newWall.start.y - newWall.end.y) < 10) newWall.end.y = newWall.start.y;
            if (dist(newWall.start, newWall.end) > 5) setEntities(prev => [...prev, newWall]);
        } else if (activeTool === 'RECT') {
            const w = mousePos.x - drawingStart.x;
            const h = mousePos.y - drawingStart.y;
            if (Math.abs(w) > 5 && Math.abs(h) > 5) {
                const newRect: RectEntity = { id: generateId(), type: 'rect', start: { x: Math.min(drawingStart.x, mousePos.x), y: Math.min(drawingStart.y, mousePos.y) }, width: Math.abs(w), height: Math.abs(h) };
                setEntities(prev => [...prev, newRect]);
            }
        } else if (activeTool === 'CIRCLE') {
            const r = dist(drawingStart, mousePos);
            if (r > 5) {
                const newCirc: CircleEntity = { id: generateId(), type: 'circle', center: drawingStart, radius: r };
                setEntities(prev => [...prev, newCirc]);
            }
        } else if (activeTool === 'DIMENSION') {
             const newDim: Dimension = { id: generateId(), type: 'dimension', start: drawingStart, end: mousePos };
             setEntities(prev => [...prev, newDim]);
        } else if (activeTool === 'LEADER') {
             const text = prompt("Enter leader text:", "Note");
             if (text) {
                 const newLeader: LeaderEntity = { id: generateId(), type: 'leader', start: drawingStart, end: mousePos, text };
                 setEntities(prev => [...prev, newLeader]);
             }
        }
        setDrawingStart(null);
    }
    setIsDragging(false);
    setDragStart(null);
  };

  const renderEntity = (e: Entity, inheritedSelection: boolean = false) => {
      const isSelected = e.selected || inheritedSelection;
      const stroke = isSelected ? COLORS.wallSelected : (e.type === 'dimension' ? COLORS.dim : COLORS.wall);
      
      if (e.type === 'wall') {
          if (!e.start || !e.end) return null;
          return <line key={e.id} x1={e.start.x} y1={e.start.y} x2={e.end.x} y2={e.end.y} stroke={stroke} strokeWidth={e.thickness} strokeLinecap="square" />;
      }
      if (e.type === 'rect') {
          if (!e.start) return null;
          return <rect key={e.id} x={e.start.x} y={e.start.y} width={e.width} height={e.height} fill="none" stroke={stroke} strokeWidth="2" />;
      }
      if (e.type === 'circle') {
          if (!e.center) return null;
          return <circle key={e.id} cx={e.center.x} cy={e.center.y} r={e.radius} fill="none" stroke={stroke} strokeWidth="2" />;
      }
      if (e.type === 'text') {
          return <text key={e.id} x={e.x} y={e.y} fill={isSelected ? COLORS.wallSelected : COLORS.text} fontSize={e.fontSize} fontFamily="monospace" textAnchor="middle">{e.content}</text>;
      }
      if (e.type === 'polyline') {
          const pts = e.points.map(p => `${p.x},${p.y}`).join(" ");
          return <polyline key={e.id} points={pts} fill="none" stroke={stroke} strokeWidth="2" />;
      }
      if (e.type === 'arc') {
          const d = getArcPath(e.p1, e.p2, e.p3);
          return <path key={e.id} d={d} fill="none" stroke={stroke} strokeWidth="2" />;
      }
      if (e.type === 'door') {
           return (
               <g key={e.id} transform={`translate(${e.x},${e.y}) rotate(${e.rotation})`}>
                   <path d={`M0,0 L${e.width},0 A${e.width},${e.width} 0 0,1 0,${e.width} L0,0`} fill="none" stroke={isSelected ? COLORS.wallSelected : COLORS.door} strokeWidth="2" />
                   <path d={`M0,0 L0,${e.width}`} stroke={isSelected ? COLORS.wallSelected : COLORS.door} strokeWidth="2" />
               </g>
           );
      }
      if (e.type === 'dimension') {
          const angle = Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x);
          return (
              <g key={e.id}>
                  <line x1={e.start.x} y1={e.start.y} x2={e.end.x} y2={e.end.y} stroke={stroke} strokeWidth="1" />
                  <line x1={e.start.x} y1={e.start.y} x2={e.start.x + Math.sin(angle)*5} y2={e.start.y - Math.cos(angle)*5} stroke={stroke} strokeWidth="1" />
                  <line x1={e.end.x} y1={e.end.y} x2={e.end.x + Math.sin(angle)*5} y2={e.end.y - Math.cos(angle)*5} stroke={stroke} strokeWidth="1" />
                  <text x={(e.start.x+e.end.x)/2} y={(e.start.y+e.end.y)/2 - 5} fill={stroke} fontSize="10" textAnchor="middle">{dist(e.start, e.end).toFixed(0)}</text>
              </g>
          )
      }
      if (e.type === 'leader') {
          return (
              <g key={e.id}>
                  <line x1={e.start.x} y1={e.start.y} x2={e.end.x} y2={e.end.y} stroke={stroke} strokeWidth="1" />
                  <circle cx={e.start.x} cy={e.start.y} r="2" fill={stroke}/>
                  <text x={e.end.x} y={e.end.y} dx="5" dy="5" fill={stroke} fontSize="12">{e.text}</text>
              </g>
          )
      }
      if (e.type === 'table') {
          const els = [];
          for(let r=0; r<=e.rows; r++) {
             els.push(<line key={`r${r}`} x1={e.x} y1={e.y + r*e.rowHeight} x2={e.x + e.cols*e.colWidth} y2={e.y + r*e.rowHeight} stroke={stroke} strokeWidth="1" />);
          }
          for(let c=0; c<=e.cols; c++) {
             els.push(<line key={`c${c}`} x1={e.x + c*e.colWidth} y1={e.y} x2={e.x + c*e.colWidth} y2={e.y + e.rows*e.rowHeight} stroke={stroke} strokeWidth="1" />);
          }
          return <g key={e.id}>{els}</g>;
      }
      if (e.type === 'centermark') {
           const s = e.size;
           return <g key={e.id}>
               <line x1={e.center.x-s} y1={e.center.y} x2={e.center.x+s} y2={e.center.y} stroke={stroke} strokeWidth="1" />
               <line x1={e.center.x} y1={e.center.y-s} x2={e.center.x} y2={e.center.y+s} stroke={stroke} strokeWidth="1" />
           </g>;
      }
      if (e.type === 'image') {
          return <image key={e.id} href={e.href} x={e.x} y={e.y} width={e.width} height={e.height} opacity={e.opacity} style={{ pointerEvents: 'none' }} />;
      }
      if (e.type === 'insert') {
          const def = blockDefs[e.blockName];
          if (!def) return null;
          return (
              <g key={e.id} transform={`translate(${e.insertPoint.x},${e.insertPoint.y}) rotate(${e.rotation}) scale(${e.scale})`}>
                  {def.entities.map(sub => renderEntity({...sub, id: e.id + sub.id}, isSelected))}
              </g>
          );
      }
      return null;
  };

  const deleteSelected = () => {
    setEntities(prev => prev.filter(e => !e.selected));
  };

  const copySelected = () => {
    setEntities(prev => {
        const selected = prev.filter(e => e.selected);
        const copies = selected.map(e => {
            const copy = JSON.parse(JSON.stringify(e));
            copy.id = generateId();
            copy.selected = true;
            const offset = 20 / view.zoom;
            if (copy.start) { copy.start.x += offset; copy.start.y += offset; }
            if (copy.end) { copy.end.x += offset; copy.end.y += offset; }
            if (copy.center) { copy.center.x += offset; copy.center.y += offset; }
            if (copy.x !== undefined) { copy.x += offset; copy.y += offset; }
            if (copy.points) { copy.points = copy.points.map((p: Point) => ({ x: p.x + offset, y: p.y + offset })); }
            if (copy.p1) { copy.p1.x += offset; copy.p1.y += offset; copy.p2.x += offset; copy.p2.y += offset; copy.p3.x += offset; copy.p3.y += offset; }
            if (copy.insertPoint) { copy.insertPoint.x += offset; copy.insertPoint.y += offset; }
            return copy;
        });
        return [...prev.map(e => ({...e, selected: false})), ...copies];
    });
  };

  const mirrorSelected = () => {
    setEntities(prev => {
        const selected = prev.filter(e => e.selected);
        if (selected.length === 0) return prev;

        let minX = Infinity, maxX = -Infinity;
        selected.forEach(e => {
             const check = (x:number) => { if(x<minX)minX=x; if(x>maxX)maxX=x; };
             if((e as any).start) check((e as any).start.x);
             if((e as any).end) check((e as any).end.x);
             if((e as any).center) check((e as any).center.x);
             if((e as any).x !== undefined) check((e as any).x);
             if((e as any).points) (e as any).points.forEach((p:Point) => check(p.x));
        });
        
        if (!isFinite(minX)) return prev;

        const axisX = (minX + maxX) / 2;
        const mirrorPoint = (p: Point) => ({ x: axisX - (p.x - axisX), y: p.y });

        return [...prev.map(e => e.selected ? { ...e, selected: false } : e), ...selected.map(e => {
             const copy = JSON.parse(JSON.stringify(e));
             copy.id = generateId();
             copy.selected = true;
             
             if (copy.type === 'wall' || copy.type === 'dimension' || copy.type === 'leader') {
                copy.start = mirrorPoint(copy.start);
                copy.end = mirrorPoint(copy.end);
             } else if (copy.type === 'rect') {
                const p = mirrorPoint(copy.start);
                copy.start.x = p.x - copy.width;
             } else if (copy.type === 'circle' || copy.type === 'centermark') {
                copy.center = mirrorPoint(copy.center);
             } else if (copy.type === 'text' || copy.type === 'image' || copy.type === 'table') {
                const p = mirrorPoint({x:copy.x, y:copy.y});
                copy.x = p.x;
             } else if (copy.type === 'polyline') {
                 copy.points = copy.points.map(mirrorPoint);
             }
             return copy;
        })];
    });
  };

  const rotateSelected = () => {
    setEntities(prev => {
        const selected = prev.filter(e => e.selected);
        if (selected.length === 0) return prev;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const check = (x:number, y:number) => {
            if(x<minX)minX=x; if(x>maxX)maxX=x;
            if(y<minY)minY=y; if(y>maxY)maxY=y;
        };
        selected.forEach(e => {
            if((e as any).start) { check((e as any).start.x, (e as any).start.y); check((e as any).end?.x??(e as any).start.x, (e as any).end?.y??(e as any).start.y); }
            if((e as any).center) { check((e as any).center.x, (e as any).center.y); }
            if((e as any).x !== undefined) { check((e as any).x, (e as any).y); }
            if((e as any).points) { (e as any).points.forEach((p:Point) => check(p.x, p.y)); }
        });

        if (!isFinite(minX)) return prev;

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const angle = Math.PI / 2;

        const rotatePoint = (p: Point) => {
            const dx = p.x - cx;
            const dy = p.y - cy;
            return {
                x: cx + (dx * Math.cos(angle) - dy * Math.sin(angle)),
                y: cy + (dx * Math.sin(angle) + dy * Math.cos(angle))
            };
        };

        return prev.map(e => {
            if (!e.selected) return e;
            const copy = JSON.parse(JSON.stringify(e));
            if (copy.type === 'wall' || copy.type === 'dimension' || copy.type === 'leader') {
                copy.start = rotatePoint(copy.start);
                copy.end = rotatePoint(copy.end);
            } else if (copy.type === 'rect') {
                const center = { x: copy.start.x + copy.width/2, y: copy.start.y + copy.height/2 };
                const newCenter = rotatePoint(center);
                copy.start.x = newCenter.x - copy.height/2;
                copy.start.y = newCenter.y - copy.width/2;
                const tmp = copy.width; copy.width = copy.height; copy.height = tmp;
            } else if (copy.type === 'circle' || copy.type === 'centermark') {
                copy.center = rotatePoint(copy.center);
            } else if (copy.type === 'text' || copy.type === 'image' || copy.type === 'table' || copy.type === 'door') {
                const p = rotatePoint({x:copy.x, y:copy.y});
                copy.x = p.x; copy.y = p.y;
                if (copy.type === 'door') copy.rotation = (copy.rotation + 90) % 360;
            } else if (copy.type === 'polyline') {
                copy.points = copy.points.map(rotatePoint);
            }
            return copy;
        });
    });
  };

  const filletSelected = () => {
    alert("Fillet not implemented.");
  };

  const renderGrid = () => {
    const gridSize = 50 * view.zoom;
    if (gridSize < 10) return null;
    const offsetX = view.x % gridSize;
    const offsetY = view.y % gridSize;
    return (
        <React.Fragment>
          <defs>
            <pattern id="grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse" x={offsetX} y={offsetY}>
              <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke={COLORS.grid} strokeWidth={1} />
            </pattern>
          </defs>
          <rect x="0" y="0" width="100%" height="100%" fill="url(#grid)" />
        </React.Fragment>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: COLORS.bg, color: "#fff", fontFamily: "'Segoe UI', sans-serif" }}>
      
      {/* 1. TOP TITLE BAR */}
      <div style={{ height: "30px", background: "#1f1f1f", display: "flex", alignItems: "center", padding: "0 12px", borderBottom: "1px solid #000" }}>
         <div style={{ color: "#e1e1e1", fontSize: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ color: "#d20a0a", fontWeight: "bold", fontSize: "16px" }}>A</span>
            <span>Autodesk AutoCAD 2025 - AI Edition</span>
            <span style={{ color: "#888" }}>[Drawing1.dwg]</span>
         </div>
         <div style={{ marginLeft: "auto", display: "flex", gap: "10px" }}>
            <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#444" }}></div>
            <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#444" }}></div>
         </div>
      </div>

      {/* 2. RIBBON (NAVBAR) */}
      <div style={{ background: COLORS.ribbonBg, borderBottom: `1px solid ${COLORS.uiBorder}` }}>
         
         {/* Tabs */}
         <div style={{ display: "flex", gap: "24px", padding: "6px 16px 0", fontSize: "13px", fontWeight: "500", borderBottom: "1px solid #444" }}>
            {["Home", "Insert", "Annotate", "Parametric", "View", "Manage", "Output", "Collaborate", "Express Tools"].map(tab => (
              <div 
                key={tab} 
                onClick={() => setActiveTab(tab)}
                style={{ 
                   color: activeTab === tab ? "#fff" : "#aaa", 
                   borderBottom: activeTab === tab ? `3px solid ${COLORS.accent}` : "3px solid transparent", 
                   paddingBottom: "6px", 
                   cursor: "pointer",
                   transition: "color 0.2s"
                }}
              >
                {tab}
              </div>
            ))}
         </div>

         {/* Ribbon Toolbar */}
         <div style={{ display: "flex", padding: "8px 10px", height: "92px", alignItems: "stretch" }}>
            
            {activeTab === "Home" && (
              <>
                {/* GROUP: DRAW */}
                <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                   <div style={{ display: "flex", gap: "4px" }}>
                       {/* Left Col (Big Buttons) */}
                       <div style={{ display: "flex", gap: "4px" }}>
                          <RibbonButton icon={Icons.Line} label="Line" big active={activeTool === 'WALL'} onClick={() => setActiveTool('WALL')} />
                          <RibbonButton icon={Icons.Polyline} label="Polyline" big active={activeTool === 'POLYLINE'} onClick={() => setActiveTool('POLYLINE')} />
                          <RibbonButton icon={Icons.Circle} label="Circle" big active={activeTool === 'CIRCLE'} onClick={() => setActiveTool('CIRCLE')} />
                          <RibbonButton icon={Icons.Arc} label="Arc" big active={activeTool === 'ARC'} onClick={() => setActiveTool('ARC')} />
                       </div>
                       {/* Right Col (Small Buttons Grid) */}
                       <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px", alignContent: "start" }}>
                          <RibbonButton icon={Icons.Rect} label="Rect" active={activeTool === 'RECT'} onClick={() => setActiveTool('RECT')} />
                          <RibbonButton icon={Icons.Door} label="Door" active={activeTool === 'DOOR'} onClick={() => setActiveTool('DOOR')} />
                          <div style={{ gridColumn: "span 2", fontSize: "10px", textAlign: "center", color: "#666", paddingTop: "2px" }}>Hatch</div>
                       </div>
                   </div>
                   <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Draw</div>
                </div>

                {/* GROUP: MODIFY */}
                <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                   <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "2px" }}>
                       <RibbonButton icon={Icons.Move} label="Move" onClick={() => setActiveTool('SELECT')} active={activeTool === 'SELECT'} />
                       <RibbonButton icon={Icons.Rotate} label="Rotate" onClick={rotateSelected} />
                       <RibbonButton icon={Icons.Trim} label="Trim" onClick={deleteSelected} />
                       <RibbonButton icon={Icons.Copy} label="Copy" onClick={copySelected} />
                       <RibbonButton icon={Icons.Mirror} label="Mirror" onClick={mirrorSelected} />
                       <RibbonButton icon={Icons.Fillet} label="Fillet" onClick={filletSelected} />
                   </div>
                   <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Modify</div>
                </div>

                 {/* GROUP: ANNOTATION */}
                <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                   <div style={{ display: "flex", gap: "4px" }}>
                       <RibbonButton icon={Icons.Text} label="Text" big active={activeTool === 'TEXT'} onClick={() => setActiveTool('TEXT')} />
                       <RibbonButton icon={Icons.Dimension} label="Dimension" big active={activeTool === 'DIMENSION'} onClick={() => setActiveTool('DIMENSION')} />
                   </div>
                   <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Annotation</div>
                </div>
              </>
            )}

            {activeTab === "Insert" && (
               <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.InsertBlock} label="Insert" big onClick={insertBlock} active={activeTool === 'INSERT_BLOCK'} />
                         <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                           <RibbonButton icon={Icons.CreateBlock} label="Create" onClick={createBlock} />
                           <RibbonButton icon={Icons.EditAttribute} label="Edit Attr" />
                           <RibbonButton icon={Icons.DefineAttribute} label="Define Attr" />
                         </div>
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Block</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <input type="file" ref={attachInputRef} style={{ display: 'none' }} onChange={handleAttachImage} accept="image/*" />
                         <RibbonButton icon={Icons.Attach} label="Attach" big onClick={() => attachInputRef.current?.click()} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Reference</div>
                 </div>
               </>
            )}

            {activeTab === "Annotate" && (
                <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.MText} label="Multiline Text" big active={activeTool === 'TEXT'} onClick={() => setActiveTool('TEXT')} />
                         <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                             <RibbonButton icon={Icons.Text} label="Single Line" onClick={() => setActiveTool('TEXT')} />
                         </div>
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Text</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Dimension} label="Dimension" big active={activeTool === 'DIMENSION'} onClick={() => setActiveTool('DIMENSION')} />
                         <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                             <RibbonButton icon={Icons.LinearDim} label="Linear" onClick={() => setActiveTool('DIMENSION')} />
                         </div>
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Dimensions</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Leader} label="Leader" big active={activeTool === 'LEADER'} onClick={() => setActiveTool('LEADER')} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Leaders</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Table} label="Table" big active={activeTool === 'TABLE'} onClick={() => setActiveTool('TABLE')} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Tables</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.CenterMark} label="Center Mark" big active={activeTool === 'CENTERMARK'} onClick={() => setActiveTool('CENTERMARK')} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Centerlines</div>
                 </div>
                </>
            )}

            {activeTab === "Parametric" && (
                <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.AutoConstrain} label="Auto Constrain" big />
                         <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                             <RibbonButton icon={Icons.Coincident} label="Coincident" />
                             <RibbonButton icon={Icons.Parallel} label="Parallel" />
                             <RibbonButton icon={Icons.Tangent} label="Tangent" />
                         </div>
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Geometric</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.LinearDim} label="Linear" big />
                         <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                             <RibbonButton icon={Icons.Lock} label="Convert" />
                         </div>
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Dimensional</div>
                 </div>
                </>
            )}

            {activeTab === "View" && (
                <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.UCS} label="UCS Icon" big />
                         <RibbonButton icon={Icons.ViewCube} label="ViewCube" big />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Viewport Tools</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.ZoomExtents} label="Extents" big onClick={zoomExtents} />
                         <RibbonButton icon={Icons.ZoomOriginal} label="Reset" big onClick={resetView} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Navigate</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.SheetSet} label="Sheet Set Manager" big />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Palettes</div>
                 </div>
                </>
            )}

            {activeTab === "Manage" && (
                <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Record} label="Record" big />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Action Recorder</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.CUI} label="User Interface" big />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Customization</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Purge} label="Purge" big onClick={purge} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Cleanup</div>
                 </div>
                </>
            )}

            {activeTab === "Output" && (
                <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Plot} label="Plot" big onClick={() => window.print()} />
                         <RibbonButton icon={Icons.Export} label="Export JSON" big onClick={exportJSON} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Plot</div>
                 </div>
                </>
            )}

            {activeTab === "Collaborate" && (
                <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Share} label="Share Drawing" big onClick={() => alert("Share link generated to clipboard!")} />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Share</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.Compare} label="DWG Compare" big />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Compare</div>
                 </div>
                </>
            )}

            {activeTab === "Express Tools" && (
                <>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.ArcText} label="Arc Aligned" big />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Text</div>
                 </div>
                 <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
                     <div style={{ display: "flex", gap: "4px" }}>
                         <RibbonButton icon={Icons.BreakLine} label="Breakline Symbol" big />
                     </div>
                     <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Draw</div>
                 </div>
                </>
            )}

         </div>
      </div>

      {/* 3. MAIN WORKSPACE */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        
        {/* LEFT PANEL */}
        <div style={{ width: "240px", background: COLORS.panelBg, borderRight: `1px solid ${COLORS.uiBorder}`, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "8px", background: "#333", fontSize: "11px", fontWeight: "600", color: "#ccc", textTransform: "uppercase" }}>Properties</div>
            <div style={{ padding: "10px", fontSize: "12px", color: "#ccc" }}>
                {entities.find(e => e.selected) ? (
                    <>
                        <div style={{ marginBottom: "10px", paddingBottom: "10px", borderBottom: "1px solid #444" }}>
                            <div style={{ color: COLORS.accent, fontWeight: "bold" }}>{entities.find(e => e.selected)?.type.toUpperCase()}</div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", rowGap: "8px" }}>
                            <label>Color</label> <span style={{ color: "#fff" }}>ByLayer</span>
                            <label>Layer</label> <span style={{ color: "#fff" }}>0</span>
                            {entities.find(e => e.selected)?.type === 'wall' && ( <><label>Length</label><span style={{ color: "#fff" }}>{dist(entities.find(e => e.selected)?.start, entities.find(e => e.selected)?.end).toFixed(1)}</span></> )}
                            {entities.find(e => e.selected)?.type === 'rect' && ( <><label>Width</label><span style={{ color: "#fff" }}>{entities.find(e => e.selected)?.width}</span><label>Height</label><span style={{ color: "#fff" }}>{entities.find(e => e.selected)?.height}</span></> )}
                        </div>
                    </>
                ) : <div style={{ color: "#666", fontStyle: "italic", textAlign: "center", marginTop: "20px" }}>No selection</div>}
            </div>
            <div style={{ flex: 1 }}></div>
            <div style={{ padding: "5px", fontSize: "11px", color: "#666", borderTop: "1px solid #333" }}>Model Space</div>
        </div>

        {/* CENTER PANEL */}
        <div 
            ref={canvasRef}
            style={{ flex: 1, position: "relative", background: "#111", cursor: activeTool === "SELECT" ? "default" : "crosshair", overflow: "hidden" }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onContextMenu={handleContextMenu}
        >
            <svg width="100%" height="100%" style={{ display: "block" }}>
                {renderGrid()}
                <g transform={`translate(${view.x}, ${view.y}) scale(${view.zoom})`}>
                    {entities.map(e => renderEntity(e))}
                    {activeTool === 'POLYLINE' && tempPoints.length > 0 && <polyline points={tempPoints.map(p => `${p.x},${p.y}`).join(" ") + ` ${mousePos.x},${mousePos.y}`} fill="none" stroke={COLORS.wallSelected} strokeWidth="2" strokeDasharray="5,5" />}
                    {activeTool === 'ARC' && tempPoints.length > 0 && (tempPoints.length === 1 ? <line x1={tempPoints[0].x} y1={tempPoints[0].y} x2={mousePos.x} y2={mousePos.y} stroke={COLORS.wallSelected} strokeWidth="2" strokeDasharray="5,5" /> : <path d={getArcPath(tempPoints[0], tempPoints[1], mousePos)} fill="none" stroke={COLORS.wallSelected} strokeWidth="2" strokeDasharray="5,5" />)}
                    {activeTool === 'INSERT_BLOCK' && activeBlockName && <g transform={`translate(${mousePos.x},${mousePos.y})`} opacity="0.5">{blockDefs[activeBlockName]?.entities.map(e => renderEntity({...e, id: 'preview-'+e.id}))}</g>}
                    {drawingStart && (
                        <>
                        {activeTool === 'WALL' && <line x1={drawingStart.x} y1={drawingStart.y} x2={mousePos.x} y2={mousePos.y} stroke={COLORS.wallSelected} strokeWidth={2} strokeDasharray="5,5" />}
                        {activeTool === 'RECT' && <rect x={Math.min(drawingStart.x, mousePos.x)} y={Math.min(drawingStart.y, mousePos.y)} width={Math.abs(mousePos.x - drawingStart.x)} height={Math.abs(mousePos.y - drawingStart.y)} fill="none" stroke={COLORS.wallSelected} strokeWidth={2} strokeDasharray="5,5" />}
                        {activeTool === 'CIRCLE' && <circle cx={drawingStart.x} cy={drawingStart.y} r={dist(drawingStart, mousePos)} fill="none" stroke={COLORS.wallSelected} strokeWidth={2} strokeDasharray="5,5" />}
                        {activeTool === 'DIMENSION' && <line x1={drawingStart.x} y1={drawingStart.y} x2={mousePos.x} y2={mousePos.y} stroke={COLORS.wallSelected} strokeWidth={1} strokeDasharray="5,5" />}
                        {activeTool === 'LEADER' && <line x1={drawingStart.x} y1={drawingStart.y} x2={mousePos.x} y2={mousePos.y} stroke={COLORS.wallSelected} strokeWidth={1} strokeDasharray="5,5" />}
                        </>
                    )}
                </g>
            </svg>
            <div style={{ position: "absolute", top: "20px", right: "20px", width: "50px", height: "50px", border: "2px solid #555", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontWeight: "bold", fontSize: "10px", pointerEvents: "none" }}>N</div>
            <div style={{ position: "absolute", bottom: "10px", left: "10px", right: "10px", height: "30px", background: "rgba(30,30,30,0.9)", border: "1px solid #444", borderRadius: "4px", display: "flex", alignItems: "center", padding: "0 10px", color: "#fff", fontSize: "12px", fontFamily: "monospace" }}>
                <span style={{ color: "#888", marginRight: "10px" }}>Command:</span>
                {activeTool === 'SELECT' ? 'Type a command' : `${activeTool} - ${activeTool === 'POLYLINE' ? 'Click next point' : activeTool === 'CENTERMARK' ? 'Select Circle/Arc' : 'Specify point'}`}
                <span style={{ animation: "blink 1s infinite", marginLeft: "2px", width: "6px", height: "14px", background: "#fff" }}></span>
            </div>
        </div>

        {/* RIGHT PANEL: AI */}
        <div style={{ width: "320px", background: COLORS.panelBg, borderLeft: `1px solid ${COLORS.uiBorder}`, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px", background: "#333", display: "flex", alignItems: "center", gap: "8px", borderBottom: `1px solid ${COLORS.uiBorder}` }}><Icons.Cpu /><span style={{ fontSize: "12px", fontWeight: "600", color: "#e0e0e0" }}>AI Assistant</span></div>
            <div style={{ flex: 1, overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "10px" }}>
                {chatHistory.map((msg, i) => (<div key={i} style={{ alignSelf: msg.role === "user" ? "flex-end" : "flex-start", background: msg.role === "user" ? "#005a9e" : "#383838", color: "#fff", padding: "8px 12px", borderRadius: "4px", maxWidth: "90%", fontSize: "12px", lineHeight: "1.4" }}>{msg.attachment && (<div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px", paddingBottom: "4px", borderBottom: "1px solid rgba(255,255,255,0.2)", fontSize: "10px", color: "#ddd" }}><Icons.Paperclip /><span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{msg.attachment.name}</span></div>)}{msg.text}</div>))}
                {isLoading && <div style={{ fontSize: "11px", color: "#888", fontStyle: "italic" }}>Generating...</div>}
            </div>
            <div style={{ padding: "10px", borderTop: `1px solid ${COLORS.uiBorder}` }}>
                {pendingFile && (<div style={{ background: "#333", padding: "4px 8px", borderRadius: "4px", marginBottom: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "11px", color: "#ccc" }}><div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}><Icons.Paperclip /><span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{pendingFile.name}</span></div><button onClick={() => { setPendingFile(null); if(fileInputRef.current) fileInputRef.current.value = ""; }} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", padding: "2px" }}><Icons.Close /></button></div>)}
                <div style={{ display: "flex", gap: "6px" }}><input type="file" ref={fileInputRef} onChange={handleFileUpload} style={{ display: "none" }} accept="image/*,application/pdf" /><button onClick={() => fileInputRef.current?.click()} style={{ background: "#333", border: "1px solid #444", color: "#ccc", width: "30px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "2px" }} title="Attach file"><Icons.Paperclip /></button><input type="text" value={userInput} onChange={(e) => setUserInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && callAI()} placeholder="Ask AI..." style={{ flex: 1, background: "#1e1e1e", border: "1px solid #444", padding: "8px", color: "#fff", fontSize: "12px", outline: "none" }} /><button onClick={callAI} style={{ background: COLORS.accent, border: "none", color: "#fff", width: "30px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><Icons.Send /></button></div>
            </div>
        </div>
      </div>

      <div style={{ height: "24px", background: "#007fd4", display: "flex", alignItems: "center", padding: "0 10px", fontSize: "11px", color: "#fff", justifyContent: "space-between" }}>
         <div style={{ display: "flex", gap: "15px" }}><span>MODEL</span><span>GRID</span><span>SNAP</span><span>ORTHO</span><span>POLAR</span></div>
         <div>{Math.round(mousePos.x)}, {Math.round(mousePos.y)}, 0.0</div>
      </div>

      <style>{`@keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } } ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-track { background: #1e1e1e; } ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; } ::-webkit-scrollbar-thumb:hover { background: #555; }`}</style>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
