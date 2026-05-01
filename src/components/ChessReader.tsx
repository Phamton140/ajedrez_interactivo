import React, { useState, useRef, useEffect } from 'react';
import { Chessboard } from 'react-chessboard';
import { FileUp, ChevronLeft, ChevronRight, Loader2, AlertTriangle } from 'lucide-react';
import { extractTextFromPdf, tokenize, parsePGNTree, translateEsToEn, translateEnToEs, type ChessState, type GameNode } from '../lib/chessParser';
import { Chess } from 'chess.js';
import { v4 as uuidv4 } from 'uuid';

export const ChessReader = () => {
  const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const [gameState, setGameState] = useState<ChessState | null>(null);
  const [currentFen, setCurrentFen] = useState(STARTING_FEN);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll effect
  useEffect(() => {
    if (activeNodeId) {
      const activeEl = document.getElementById(`node-${activeNodeId}`);
      if (activeEl && scrollRef.current) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [activeNodeId]);
  
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setLoading(true);
    try {
      const text = await extractTextFromPdf(file);
      const tokens = tokenize(text);
      const state = parsePGNTree(tokens);
      setGameState(state);
      setCurrentFen(STARTING_FEN);
      setActiveNodeId(state.rootId);
    } catch (err) {
      console.error(err);
      alert('Hubo un error al procesar el PDF. Revisa la consola.');
    } finally {
      setLoading(false);
    }
  };

  const goToNode = (nodeId: string) => {
    if (!gameState) return;
    const node = gameState.nodes[nodeId];
    if (node) {
      if (node.type === 'move' || node.type === 'missing_move') {
        setCurrentFen(node.fen);
      } else if (node.type === 'root') {
        setCurrentFen(STARTING_FEN);
      }
      setActiveNodeId(nodeId);
    }
  };

  const goNext = () => {
    if (!gameState || !activeNodeId) return;
    const node = gameState.nodes[activeNodeId];
    // Siguiente jugada es la primera variante (línea principal)
    if (node.childrenIds.length > 0) {
      goToNode(node.childrenIds[0]);
    }
  };

  const goPrev = () => {
    if (!gameState || !activeNodeId) return;
    const node = gameState.nodes[activeNodeId];
    if (node.parentId) {
      goToNode(node.parentId);
    }
  };

  const onPieceDrop = ({ sourceSquare, targetSquare, piece }: { sourceSquare: string, targetSquare: string | null, piece: { pieceType: string } }) => {
    if (!gameState || !activeNodeId || !targetSquare) return false;

    const chess = new Chess(currentFen);
    
    let move;
    try {
      move = chess.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: piece.pieceType?.[1]?.toLowerCase() || 'q',
      });
    } catch {
      return false;
    }

    if (move) {
      const node = gameState.nodes[activeNodeId];
      
      const existingChildId = node.childrenIds.find(childId => {
        const child = gameState.nodes[childId];
        return child.sanEn === move.san;
      });

      if (existingChildId) {
        goToNode(existingChildId);
        return true;
      }

      const newNodeId = uuidv4();
      const newNode: GameNode = {
        id: newNodeId,
        parentId: activeNodeId,
        childrenIds: [],
        type: 'move',
        sanEs: translateEnToEs(move.san),
        sanEn: move.san,
        fen: chess.fen(),
        moveNumber: chess.moveNumber() - (chess.turn() === 'w' ? 1 : 0),
        turn: chess.turn(),
        playedColor: chess.turn() === 'w' ? 'b' : 'w',
        commentBefore: '',
        commentAfter: ' [Variante del usuario]',
        isValid: true,
        isMainLine: false,
      };

      setGameState(prevState => {
        if (!prevState) return prevState;
        // Deep copy the nodes to avoid mutating previous state
        const newState = {
          ...prevState,
          nodes: {
            ...prevState.nodes,
            [activeNodeId]: {
              ...prevState.nodes[activeNodeId],
              childrenIds: [...prevState.nodes[activeNodeId].childrenIds, newNodeId],
            },
            [newNodeId]: newNode,
          },
        };
        return newState;
      });
      
      setCurrentFen(newNode.fen);
      setActiveNodeId(newNodeId);
      return true;
    }
    
    return false;
  };

  const fixMissingMove = (nodeId: string) => {
    const manualSan = prompt('Introduce la jugada faltante en notación estándar (ej. c5, Nf3):');
    if (!manualSan) return;

    setGameState(prevState => {
      if (!prevState) return prevState;
      const newState = { ...prevState };
      const node = newState.nodes[nodeId];
      
      if (!node || node.type !== 'missing_move') return prevState;

      // Intentar validar la nueva jugada
      const parentFen = newState.nodes[node.parentId!].fen;
      const chess = new Chess(parentFen);
      const manualSanEn = translateEsToEn(manualSan);
      try {
        const move = chess.move(manualSanEn);
        if (move) {
          // Transformar nodo
          node.type = 'move';
          node.sanEs = manualSan; // Asumimos que introdujo SAN correcto
          node.sanEn = manualSanEn;
          node.isValid = true;
          node.error = undefined;
          node.fen = chess.fen();
          node.commentAfter = '';
          
          // Re-evaluar todo el subárbol
          reEvaluateSubtree(newState, nodeId);
          
          setCurrentFen(node.fen);
        } else {
          alert('Jugada no válida en esta posición.');
        }
      } catch {
        alert('Formato de jugada incorrecto.');
      }
      return newState;
    });
  };

  const fixInvalidMove = (nodeId: string) => {
    setGameState(prevState => {
      if (!prevState) return prevState;
      const newState = { ...prevState };
      const node = newState.nodes[nodeId];
      
      if (!node || node.isValid) return prevState;

      const action = prompt(
        `La jugada "${node.sanEs}" es inválida.\n\nEscribe la jugada correcta (ej. Cf3), o escribe "texto" si esto es solo un comentario del libro y no una jugada real:`, 
        node.sanEs
      );
      
      if (!action) return prevState;

      if (action.toLowerCase().trim() === 'texto') {
        node.type = 'text';
        node.error = undefined;
        // Any children might also need to be text, but let's let the user do it manually or leave them as invalid.
        return newState;
      }

      const parentFen = newState.nodes[node.parentId!].fen;
      const chess = new Chess(parentFen);
      const manualSanEn = translateEsToEn(action);
      try {
        const move = chess.move(manualSanEn);
        if (move) {
          node.sanEs = action;
          node.sanEn = manualSanEn;
          node.isValid = true;
          node.error = undefined;
          node.fen = chess.fen();
          reEvaluateSubtree(newState, nodeId);
          setCurrentFen(node.fen);
        } else {
          alert('Jugada no válida en esta posición.');
        }
      } catch {
        alert('Formato de jugada incorrecto.');
      }
      return newState;
    });
  };

  const reEvaluateSubtree = (state: ChessState, startNodeId: string) => {
    const node = state.nodes[startNodeId];
    for (const childId of node.childrenIds) {
      const child = state.nodes[childId];
      if (child.type === 'move') {
        const chess = new Chess(node.fen); // Estado del padre
        try {
          const move = chess.move(child.sanEn);
          if (move) {
            child.isValid = true;
            child.fen = chess.fen();
            child.error = undefined;
          } else {
            child.isValid = false;
            child.fen = node.fen; // Se queda con el fen del padre
          }
        } catch {
          child.isValid = false;
          child.fen = node.fen;
        }
        reEvaluateSubtree(state, childId);
      }
    }
  };

  // Función recursiva para renderizar el árbol PGN de forma intercalada
  const renderTree = (nodeId: string, isVariation = false): React.ReactNode => {
    if (!gameState) return null;
    const node = gameState.nodes[nodeId];
    if (!node) return null;

    if (node.type === 'root') {
      return (
        <div className="flex flex-col gap-6">
          {node.childrenIds.map((childId, index) => (
             <div key={`game-${childId}`} className="p-4 bg-slate-900/30 rounded-xl border border-slate-800 shadow-inner">
               <div className="text-slate-500 text-xs mb-3 font-bold uppercase tracking-widest flex items-center">
                 <span className="bg-slate-800 px-2 py-1 rounded-md">Capítulo / Variante {index + 1}</span>
               </div>
               <div className="leading-relaxed">
                 {renderTree(childId, false)}
               </div>
             </div>
          ))}
        </div>
      );
    }

    const parent = node.parentId ? gameState.nodes[node.parentId] : null;
    const isMainChild = parent ? parent.childrenIds[0] === nodeId : false;
    const isActive = nodeId === activeNodeId;

    return (
      <React.Fragment key={nodeId}>
        {node.commentBefore && <span className="text-slate-400 mx-1">{node.commentBefore}</span>}
        
        {/* Número de jugada (solo si es blancas, o si es negras y es el primer movimiento de la variante) */}
        {(node.playedColor === 'w' || (node.playedColor === 'b' && (!parent || parent.type === 'root' || parent.childrenIds[0] !== nodeId))) && (
          <span className="text-slate-500 font-mono text-[0.9em] ml-2 mr-1">
            {node.playedColor === 'w' ? `${node.moveNumber}.` : `${node.moveNumber}...`}
          </span>
        )}

        {/* Render la jugada */}
        {node.type === 'text' && (
          <span className="text-slate-400 mx-1">{node.sanEs}</span>
        )}
        {(node.type === 'move' || node.type === 'missing_move') && (
          <span 
            id={`node-${nodeId}`}
            onClick={(e) => {
              e.stopPropagation();
              if (node.type === 'missing_move') {
                fixMissingMove(nodeId);
              } else if (!node.isValid) {
                fixInvalidMove(nodeId);
              } else {
                goToNode(nodeId);
              }
            }}
            className={`
              inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 rounded-md cursor-pointer font-sans font-bold transition-all duration-200 select-none
              ${node.type === 'missing_move'
                ? 'bg-orange-600 text-white animate-pulse shadow-lg ring-2 ring-orange-400 hover:bg-orange-500'
                : isActive 
                  ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30 ring-2 ring-blue-400 ring-offset-2 ring-offset-slate-950 scale-110 z-10 relative' 
                  : node.isValid 
                    ? 'bg-slate-800 text-blue-300 hover:bg-slate-700 hover:text-blue-200 hover:scale-105'
                    : 'bg-red-900/50 text-red-400 border border-red-500/50 hover:bg-red-800/50'}
            `}
            title={node.error ? `Error: ${node.error}` : ''}
          >
            {node.error && node.type !== 'missing_move' && <AlertTriangle size={14} className="mr-1 inline" />}
            {node.sanEs}
          </span>
        )}

        {node.commentAfter && <span className="text-slate-400 mx-1">{node.commentAfter}</span>}

        {/* Variantes (hermanos del nodo actual) se renderizan justo después del nodo principal */}
        {isMainChild && parent && parent.type !== 'root' && parent.childrenIds.length > 1 && (
          <>
            {parent.childrenIds.slice(1).map(varId => (
              <span key={`var-${varId}`} className="inline-block mx-1 px-2 py-1 bg-slate-900/80 rounded-lg border border-slate-800/50 text-[0.9em] text-slate-400">
                ( {renderTree(varId, true)} )
              </span>
            ))}
          </>
        )}

        {/* Continuación (hijo principal) */}
        {node.childrenIds.length > 0 && renderTree(node.childrenIds[0], isVariation)}
      </React.Fragment>
    );
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">
      <div className="w-full lg:w-1/2 p-4 lg:p-8 border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col items-center justify-center bg-slate-900/50 shadow-inner">
        <div className="w-full max-w-[500px] mb-8 relative group">
          <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-sm blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
          <div className="relative shadow-2xl rounded-sm overflow-hidden ring-1 ring-slate-800/50 bg-slate-800">
            <Chessboard 
              options={{
                position: currentFen,
                onPieceDrop: onPieceDrop,
                darkSquareStyle: { backgroundColor: 'var(--color-board-dark)' },
                lightSquareStyle: { backgroundColor: 'var(--color-board-light)' },
                animationDurationInMs: 300
              }}
            />
          </div>
        </div>
        <div className="text-[10px] text-slate-600 font-mono mb-4 w-full text-center truncate px-4">
          FEN: {currentFen}
        </div>
        
        <div className="flex gap-4">
          <button 
            onClick={goPrev} 
            className="flex items-center justify-center p-3 sm:px-6 sm:py-3 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 rounded-full sm:rounded-xl transition-all shadow-lg hover:shadow-xl ring-1 ring-white/5 disabled:opacity-50"
            disabled={!gameState || activeNodeId === gameState.rootId}
          >
            <ChevronLeft size={24} />
            <span className="hidden sm:inline font-medium ml-2">Anterior</span>
          </button>
          <button 
            onClick={goNext} 
            className="flex items-center justify-center p-3 sm:px-6 sm:py-3 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-full sm:rounded-xl transition-all shadow-lg shadow-blue-900/20 hover:shadow-blue-900/40 disabled:opacity-50"
            disabled={!gameState || !activeNodeId || gameState.nodes[activeNodeId].childrenIds.length === 0}
          >
            <span className="hidden sm:inline font-medium mr-2">Siguiente</span>
            <ChevronRight size={24} />
          </button>
        </div>
      </div>

      <div className="w-full lg:w-1/2 flex flex-col h-full bg-slate-950 relative">
        <div className="px-6 py-4 border-b border-slate-800/80 bg-slate-900/80 backdrop-blur-md flex items-center justify-between z-20 sticky top-0">
          <h1 className="text-2xl font-black tracking-tight bg-gradient-to-br from-white via-blue-100 to-blue-400 bg-clip-text text-transparent">
            Ajedrez Interactivo
          </h1>
          <label className="flex items-center gap-2 px-5 py-2.5 bg-white/10 hover:bg-white/20 text-white rounded-xl cursor-pointer transition-all border border-white/5 shadow-sm hover:shadow-md">
            <FileUp size={18} />
            <span className="font-semibold text-sm">Cargar PDF</span>
            <input type="file" accept="application/pdf" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 lg:p-10 scroll-smooth z-10" ref={scrollRef}>
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-4">
              <Loader2 size={48} className="animate-spin text-blue-500" />
              <p className="text-lg font-medium animate-pulse">Tokenizando, analizando y construyendo árbol PGN...</p>
            </div>
          ) : !gameState ? (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-md mx-auto space-y-6">
              <div className="w-24 h-24 bg-slate-800/50 rounded-full flex items-center justify-center ring-1 ring-white/10">
                <FileUp size={40} className="text-slate-400" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-slate-200 mb-2">Ningún libro cargado</h3>
                <p className="text-slate-400 leading-relaxed">
                  Sube un libro de ajedrez en formato PDF. El sistema extraerá el texto, construirá un árbol con las variantes usando nuestra pipeline NLP, y generará una lección interactiva.
                </p>
              </div>
            </div>
          ) : (
            <div className="text-lg leading-[2.2] text-slate-300 font-serif">
              {renderTree(gameState.rootId)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
