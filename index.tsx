import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type, Schema } from "@google/genai";

// --- Types & Constants ---

type Point = { x: number; y: number };
type ToolType = "SELECT" | "WALL" | "DOOR" | "WINDOW" | "TEXT" | "CIRCLE" | "RECT";
type EntityType = "wall" | "door" | "window" | "text" | "dimension";

interface Entity {
  id: string;
  type: EntityType;
  selected?: boolean;
  [key: string]: any;
}

interface Wall extends Entity {
  type: "wall";
  start: Point;
  end: Point;
  thickness: number;
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
  bg: "#1e1e1e", // Dark gray workspace
  ribbonBg: "#2b2b2b",
  panelBg: "#252526",
  grid: "#2a2a2a",
  gridMajor: "#333",
  wall: "#dcdcdc",
  wallSelected: "#007fd4", // Selection blue
  door: "#ffd700",
  text: "#ffffff",
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

// --- Icons ---
// Expanded set to match AutoCAD ribbon

const Icons = {
  // Draw
  Line: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="2" fill="currentColor"/><circle cx="20" cy="4" r="2" fill="currentColor"/></svg>,
  Polyline: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 21 9 5 15 15 21 3"/></svg>,
  Circle: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>,
  Arc: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20 A 18 18 0 0 1 20 4"/></svg>,
  Rect: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16"/></svg>,
  Door: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 21V3h2v18"/><path d="M8 21h10v-9a9 9 0 0 0-9-9h-1"/></svg>,
  
  // Modify
  Move: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M19 9l3 3-3 3"/><path d="M9 19l3 3 3-3"/><path d="M2 12h20"/><path d="M12 2v20"/></svg>,
  Rotate: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12A10 10 0 0 0 12 2v10z"/><path d="M12 12L2.06 13.5a10 10 0 0 0 8.4 8.4z"/></svg>,
  Trim: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 3L3 21"/><circle cx="12" cy="12" r="5" strokeDasharray="2 2"/></svg>,
  Copy: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  Mirror: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20"/><path d="M18 6l-6 5 6 5V6z"/><path d="M6 16l6-5-6-5v10z"/></svg>,
  Fillet: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21h8a8 8 0 0 0 8-8V3"/></svg>,
  
  // Annotation
  Text: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M8 20h8"/></svg>,
  Dimension: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 21l-4.5-4.5"/><path d="M3 21l4.5-4.5"/><path d="M7.5 16.5l9 0"/><path d="M21 3v5"/><path d="M3 3v5"/><path d="M3 5h18"/><path d="M12 2v3"/></svg>,

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
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, zoom: 1 });
  const [activeTool, setActiveTool] = useState<ToolType>("SELECT");
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [drawingStart, setDrawingStart] = useState<Point | null>(null);
  const [mousePos, setMousePos] = useState<Point>({ x: 0, y: 0 });
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
    { role: "model", text: "Ready to design. Type commands or draw." }
  ]);
  const [userInput, setUserInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  
  // File Upload State
  const [pendingFile, setPendingFile] = useState<{data: string, mimeType: string, name: string} | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canvasRef = useRef<HTMLDivElement>(null);

  // --- AI ---
  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.API_KEY || "" }), []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      // Remove "data:*/*;base64," prefix for API
      const base64Data = base64String.split(',')[1];
      
      setPendingFile({
        data: base64Data,
        mimeType: file.type,
        name: file.name
      });
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be selected again if needed
    e.target.value = "";
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
    
    // Store pending file locally for the API call then clear state
    const currentFile = pendingFile;
    setPendingFile(null);
    setUserInput("");
    setIsLoading(true);

    try {
      const context = JSON.stringify(entities.map(({ selected, ...rest }) => rest));
      const systemPrompt = `
      You are an expert architectural AI assistant embedded in a CAD tool.
      Current Drawing State (JSON): ${context}
      
      Interpret the user's architectural request.
      Assume 1 unit = 2cm. Standard room ~400 units.
      If the user uploads an image/PDF (e.g., a floor plan), analyze it and suggest or create corresponding geometry (Walls, Doors) if requested.
      
      Response JSON Schema:
      {
        "message": "string",
        "actions": [
          { "action": "create" | "update" | "delete" | "clear", "entity": object, "id": string }
        ]
      }
      Entity types: wall (start,end,thickness), door (x,y,width,rotation), text (x,y,content).
      `;

      const model = ai.models.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: systemPrompt,
      });

      // Construct parts
      const parts: any[] = [];
      if (currentFile) {
          parts.push({
              inlineData: {
                  mimeType: currentFile.mimeType,
                  data: currentFile.data
              }
          });
      }
      if (newMsg.text) {
          parts.push({ text: newMsg.text });
      }

      const result = await model.generateContent({
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json" }
      });

      const responseText = result.response.text();
      if (responseText) {
        const responseData = JSON.parse(responseText);
        if (responseData.actions) {
          let currentEntities = [...entities];
          responseData.actions.forEach((act: any) => {
            if (act.action === "clear") currentEntities = [];
            else if (act.action === "create") currentEntities.push({ ...act.entity, id: generateId() });
            else if (act.action === "delete") currentEntities = currentEntities.filter(e => e.id !== act.id);
            else if (act.action === "update") currentEntities = currentEntities.map(e => e.id === act.id ? { ...e, ...act.entity } : e);
          });
          setEntities(currentEntities);
        }
        setChatHistory(prev => [...prev, { role: "model", text: responseData.message || "Done." }]);
      }
    } catch (e) {
      console.error(e);
      setChatHistory(prev => [...prev, { role: "model", text: "Error processing request." }]);
    } finally {
      setIsLoading(false);
    }
  };

  // --- Canvas Logic ---

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
               if (ent.type === 'wall') {
                   const w = ent as Wall;
                   const l2 = Math.pow(w.end.x - w.start.x, 2) + Math.pow(w.end.y - w.start.y, 2);
                   if (l2 === 0) return dist(worldPos, w.start) < 10;
                   let t = ((worldPos.x - w.start.x) * (w.end.x - w.start.x) + (worldPos.y - w.start.y) * (w.end.y - w.start.y)) / l2;
                   t = Math.max(0, Math.min(1, t));
                   const proj = { x: w.start.x + t * (w.end.x - w.start.x), y: w.start.y + t * (w.end.y - w.start.y) };
                   return dist(worldPos, proj) < w.thickness;
               }
               return false;
            });
            setEntities(prev => prev.map(en => ({ ...en, selected: hit ? en.id === hit.id : false })));
        }
    } else if (activeTool === "WALL") {
        setDrawingStart(worldPos);
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
        setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
        setDragStart({ x: mx, y: my });
    }
  };

  const handleMouseUp = () => {
    if (activeTool === "WALL" && drawingStart) {
        const newWall: Wall = {
            id: generateId(),
            type: "wall",
            start: drawingStart,
            end: mousePos,
            thickness: 10
        };
        // Ortho snap
        if (Math.abs(newWall.start.x - newWall.end.x) < 20) newWall.end.x = newWall.start.x;
        if (Math.abs(newWall.start.y - newWall.end.y) < 20) newWall.end.y = newWall.start.y;

        if (dist(newWall.start, newWall.end) > 10) {
            setEntities([...entities, newWall]);
        }
        setDrawingStart(null);
    }
    setIsDragging(false);
    setDragStart(null);
  };

  // --- Grid & Render ---
  const renderGrid = () => (
    <g className="grid">
        <defs>
            <pattern id="smallGrid" width={50} height={50} patternUnits="userSpaceOnUse">
                <path d="M 50 0 L 0 0 0 50" fill="none" stroke={COLORS.grid} strokeWidth="0.5"/>
            </pattern>
            <pattern id="grid" width={250} height={250} patternUnits="userSpaceOnUse">
                <rect width="250" height="250" fill="url(#smallGrid)"/>
                <path d="M 250 0 L 0 0 0 250" fill="none" stroke={COLORS.gridMajor} strokeWidth="1"/>
            </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" transform={`translate(${view.x % 250}, ${view.y % 250}) scale(${view.zoom})`} />
    </g>
  );

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
            {/* Window controls mockup */}
            <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#444" }}></div>
            <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#444" }}></div>
         </div>
      </div>

      {/* 2. RIBBON (NAVBAR) */}
      <div style={{ background: COLORS.ribbonBg, borderBottom: `1px solid ${COLORS.uiBorder}` }}>
         
         {/* Tabs */}
         <div style={{ display: "flex", gap: "24px", padding: "6px 16px 0", fontSize: "13px", fontWeight: "500", borderBottom: "1px solid #444" }}>
            <div style={{ color: "#fff", borderBottom: `3px solid ${COLORS.accent}`, paddingBottom: "6px", cursor: "pointer" }}>Home</div>
            <div style={{ color: "#aaa", paddingBottom: "6px", cursor: "pointer" }}>Insert</div>
            <div style={{ color: "#aaa", paddingBottom: "6px", cursor: "pointer" }}>Annotate</div>
            <div style={{ color: "#aaa", paddingBottom: "6px", cursor: "pointer" }}>Parametric</div>
            <div style={{ color: "#aaa", paddingBottom: "6px", cursor: "pointer" }}>View</div>
            <div style={{ color: "#aaa", paddingBottom: "6px", cursor: "pointer" }}>Manage</div>
            <div style={{ color: "#aaa", paddingBottom: "6px", cursor: "pointer" }}>Output</div>
         </div>

         {/* Ribbon Toolbar */}
         <div style={{ display: "flex", padding: "8px 10px", height: "92px", alignItems: "stretch" }}>
            
            {/* GROUP: DRAW */}
            <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
               <div style={{ display: "flex", gap: "4px" }}>
                   {/* Left Col (Big Buttons) */}
                   <div style={{ display: "flex", gap: "4px" }}>
                      <RibbonButton icon={Icons.Line} label="Line" big active={activeTool === 'WALL'} onClick={() => setActiveTool('WALL')} />
                      <RibbonButton icon={Icons.Polyline} label="Polyline" big />
                      <RibbonButton icon={Icons.Circle} label="Circle" big />
                      <RibbonButton icon={Icons.Arc} label="Arc" big />
                   </div>
                   {/* Right Col (Small Buttons Grid) */}
                   <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px", alignContent: "start" }}>
                      <RibbonButton icon={Icons.Rect} label="Rect" />
                      <RibbonButton icon={Icons.Door} label="Door" active={activeTool === 'DOOR'} onClick={() => setActiveTool('DOOR')} />
                      <div style={{ gridColumn: "span 2", fontSize: "10px", textAlign: "center", color: "#666", paddingTop: "2px" }}>Hatch</div>
                   </div>
               </div>
               <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Draw</div>
            </div>

            {/* GROUP: MODIFY */}
            <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
               <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "2px" }}>
                   <RibbonButton icon={Icons.Move} label="Move" />
                   <RibbonButton icon={Icons.Rotate} label="Rotate" />
                   <RibbonButton icon={Icons.Trim} label="Trim" />
                   <RibbonButton icon={Icons.Copy} label="Copy" />
                   <RibbonButton icon={Icons.Mirror} label="Mirror" />
                   <RibbonButton icon={Icons.Fillet} label="Fillet" />
               </div>
               <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Modify</div>
            </div>

             {/* GROUP: ANNOTATION */}
            <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #444", paddingRight: "10px", marginRight: "10px" }}>
               <div style={{ display: "flex", gap: "4px" }}>
                   <RibbonButton icon={Icons.Text} label="Text" big active={activeTool === 'TEXT'} onClick={() => setActiveTool('TEXT')} />
                   <RibbonButton icon={Icons.Dimension} label="Dimension" big />
               </div>
               <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Annotation</div>
            </div>

            {/* GROUP: LAYERS */}
            <div style={{ display: "flex", flexDirection: "column", paddingRight: "10px" }}>
               <div style={{ background: "#222", border: "1px solid #444", borderRadius: "2px", padding: "4px", width: "160px", marginBottom: "4px" }}>
                   <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                       <div style={{ width: "14px", height: "14px", background: "white", border: "1px solid #ccc" }}></div>
                       <span style={{ fontSize: "12px" }}>0</span>
                   </div>
               </div>
               <div style={{ display: "flex", gap: "2px" }}>
                   <RibbonButton icon={Icons.Cursor} label="Match" />
                   <RibbonButton icon={Icons.Cursor} label="Properties" />
               </div>
               <div style={{ marginTop: "auto", textAlign: "center", fontSize: "11px", color: COLORS.ribbonLabel }}>Layers</div>
            </div>

         </div>
      </div>

      {/* 3. MAIN WORKSPACE */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        
        {/* LEFT PANEL: PROPERTIES (Docked) */}
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
                            <label>Linetype</label> <span style={{ color: "#fff" }}>Continuous</span>
                            {/* Dynamic Props */}
                            {entities.find(e => e.selected)?.type === 'wall' && (
                                <>
                                    <label>Length</label>
                                    <span style={{ color: "#fff" }}>
                                        {dist(entities.find(e => e.selected)?.start, entities.find(e => e.selected)?.end).toFixed(1)}
                                    </span>
                                </>
                            )}
                        </div>
                    </>
                ) : (
                    <div style={{ color: "#666", fontStyle: "italic", textAlign: "center", marginTop: "20px" }}>No selection</div>
                )}
            </div>
            {/* Spacer */}
            <div style={{ flex: 1 }}></div>
            {/* Bottom Status Mock */}
            <div style={{ padding: "5px", fontSize: "11px", color: "#666", borderTop: "1px solid #333" }}>Model Space</div>
        </div>

        {/* CENTER PANEL: CANVAS */}
        <div 
            ref={canvasRef}
            style={{ flex: 1, position: "relative", background: "#111", cursor: "crosshair", overflow: "hidden" }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
        >
            <svg width="100%" height="100%" style={{ display: "block" }}>
                {renderGrid()}
                <g transform={`translate(${view.x}, ${view.y}) scale(${view.zoom})`}>
                    {/* Walls */}
                    {entities.filter(e => e.type === "wall").map((e: any) => (
                        <line 
                            key={e.id}
                            x1={e.start.x} y1={e.start.y}
                            x2={e.end.x} y2={e.end.y}
                            stroke={e.selected ? COLORS.wallSelected : COLORS.wall}
                            strokeWidth={e.thickness}
                            strokeLinecap="square"
                        />
                    ))}
                    {/* Doors */}
                    {entities.filter(e => e.type === "door").map((e: any) => (
                        <g key={e.id} transform={`translate(${e.x},${e.y}) rotate(${e.rotation})`}>
                            <path d={`M0,0 L${e.width},0 A${e.width},${e.width} 0 0,1 0,${e.width} L0,0`} fill="none" stroke={COLORS.door} strokeWidth="2" />
                            <path d={`M0,0 L0,${e.width}`} stroke={COLORS.door} strokeWidth="2" />
                        </g>
                    ))}
                    {/* Text */}
                    {entities.filter(e => e.type === "text").map((e: any) => (
                        <text 
                            key={e.id} x={e.x} y={e.y} 
                            fill={COLORS.text} fontSize={e.fontSize || 20} 
                            fontFamily="monospace" textAnchor="middle"
                        >
                            {e.content}
                        </text>
                    ))}
                    {/* Drawing Preview */}
                    {activeTool === "WALL" && drawingStart && (
                        <line 
                            x1={drawingStart.x} y1={drawingStart.y}
                            x2={mousePos.x} y2={mousePos.y}
                            stroke={COLORS.wallSelected} strokeWidth={10} strokeDasharray="10,5" opacity={0.6}
                        />
                    )}
                </g>
            </svg>
            
            {/* ViewCube Mock (Top Right) */}
            <div style={{ position: "absolute", top: "20px", right: "20px", width: "50px", height: "50px", border: "2px solid #555", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontWeight: "bold", fontSize: "10px", pointerEvents: "none" }}>
                N
            </div>
            
            {/* Command Line Mock (Bottom) */}
            <div style={{ position: "absolute", bottom: "10px", left: "10px", right: "10px", height: "30px", background: "rgba(30,30,30,0.9)", border: "1px solid #444", borderRadius: "4px", display: "flex", alignItems: "center", padding: "0 10px", color: "#fff", fontSize: "12px", fontFamily: "monospace" }}>
                <span style={{ color: "#888", marginRight: "10px" }}>Command:</span>
                {activeTool === 'WALL' ? 'LINE Specify first point:' : activeTool === 'SELECT' ? 'Type a command' : activeTool}
                <span style={{ animation: "blink 1s infinite", marginLeft: "2px", width: "6px", height: "14px", background: "#fff" }}></span>
            </div>
        </div>

        {/* RIGHT PANEL: AI ASSISTANT */}
        <div style={{ width: "320px", background: COLORS.panelBg, borderLeft: `1px solid ${COLORS.uiBorder}`, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px", background: "#333", display: "flex", alignItems: "center", gap: "8px", borderBottom: `1px solid ${COLORS.uiBorder}` }}>
                <Icons.Cpu />
                <span style={{ fontSize: "12px", fontWeight: "600", color: "#e0e0e0" }}>AI Assistant</span>
            </div>
            
            <div style={{ flex: 1, overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "10px" }}>
                {chatHistory.map((msg, i) => (
                    <div key={i} style={{ 
                        alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                        background: msg.role === "user" ? "#005a9e" : "#383838",
                        color: "#fff",
                        padding: "8px 12px",
                        borderRadius: "4px",
                        maxWidth: "90%",
                        fontSize: "12px",
                        lineHeight: "1.4"
                    }}>
                        {msg.attachment && (
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px", paddingBottom: "4px", borderBottom: "1px solid rgba(255,255,255,0.2)", fontSize: "10px", color: "#ddd" }}>
                             <Icons.Paperclip />
                             <span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{msg.attachment.name}</span>
                          </div>
                        )}
                        {msg.text}
                    </div>
                ))}
                {isLoading && <div style={{ fontSize: "11px", color: "#888", fontStyle: "italic" }}>Generating...</div>}
            </div>

            <div style={{ padding: "10px", borderTop: `1px solid ${COLORS.uiBorder}` }}>
                {pendingFile && (
                  <div style={{ background: "#333", padding: "4px 8px", borderRadius: "4px", marginBottom: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "11px", color: "#ccc" }}>
                     <div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
                        <Icons.Paperclip />
                        <span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{pendingFile.name}</span>
                     </div>
                     <button onClick={() => { setPendingFile(null); if(fileInputRef.current) fileInputRef.current.value = ""; }} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", padding: "2px" }}><Icons.Close /></button>
                  </div>
                )}
                
                <div style={{ display: "flex", gap: "6px" }}>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      onChange={handleFileUpload} 
                      style={{ display: "none" }} 
                      accept="image/*,application/pdf"
                    />
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      style={{ background: "#333", border: "1px solid #444", color: "#ccc", width: "30px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "2px" }}
                      title="Attach file"
                    >
                        <Icons.Paperclip />
                    </button>
                    <input 
                        type="text" 
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && callAI()}
                        placeholder="Ask AI..."
                        style={{
                            flex: 1,
                            background: "#1e1e1e",
                            border: "1px solid #444",
                            padding: "8px",
                            color: "#fff",
                            fontSize: "12px",
                            outline: "none"
                        }}
                    />
                    <button onClick={callAI} style={{ background: COLORS.accent, border: "none", color: "#fff", width: "30px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Icons.Send />
                    </button>
                </div>
            </div>
        </div>
      </div>

      {/* 4. STATUS BAR (Bottom Strip) */}
      <div style={{ height: "24px", background: "#007fd4", display: "flex", alignItems: "center", padding: "0 10px", fontSize: "11px", color: "#fff", justifyContent: "space-between" }}>
         <div style={{ display: "flex", gap: "15px" }}>
            <span>MODEL</span>
            <span>GRID</span>
            <span>SNAP</span>
            <span>ORTHO</span>
            <span>POLAR</span>
         </div>
         <div>
            {Math.round(mousePos.x)}, {Math.round(mousePos.y)}, 0.0
         </div>
      </div>

      <style>{`
        @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #1e1e1e; }
        ::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #555; }
      `}</style>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
