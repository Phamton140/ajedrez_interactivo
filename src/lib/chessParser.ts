import { Chess } from 'chess.js';
import * as pdfjsLib from 'pdfjs-dist';
import { v4 as uuidv4 } from 'uuid';

// Import pdf worker as URL to avoid Vite build issues
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface GameNode {
  id: string;
  parentId: string | null;
  childrenIds: string[]; // Variantes. El índice 0 es la línea principal.
  
  type: 'root' | 'move' | 'missing_move' | 'text';
  
  sanEs: string; // Notación en español (ej. "Cxd4") o "???"
  sanEn: string; // Notación en inglés (ej. "Nxd4")
  fen: string;
  
  moveNumber: number;
  turn: 'w' | 'b';
  
  commentBefore: string; 
  commentAfter: string;
  
  isValid: boolean;
  error?: string;
  isMainLine: boolean;
  missingColor?: 'w' | 'b'; // Indica qué color omitió la jugada
  playedColor?: 'w' | 'b';
  pageNumber?: number; // Página del PDF donde aparece esta jugada
}

export interface ChessState {
  nodes: Record<string, GameNode>;
  rootId: string;
  totalPages: number;
}

export type TokenType = 'MoveNumber' | 'SAN' | 'ParenOpen' | 'ParenClose' | 'NAG' | 'Text' | 'PageBreak';

export interface Token {
  type: TokenType;
  value: string;
  page?: number;
}

const SAN_REGEX = /^([RDTAC])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([RDTAC]))?([+#]?)([?!]*)$/;
const CASTLING_REGEX = /^O-O(-O)?([+#]?)([?!]*)$/;

export const extractTextFromPdf = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: { str: string }) => item.str).join(' ');
    // Marcador especial de página para mantener numeración
    fullText += `@@PAGE:${i}@@ ` + pageText + ' \n ';
  }
  
  return fullText;
};

/**
 * Extrae el texto de cada página individualmente, para uso en sistemas de navegación por páginas.
 */
export const extractTextByPage = async (file: File): Promise<{ page: number; text: string }[]> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: { page: number; text: string }[] = [];
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item: { str: string }) => item.str).join(' ');
    pages.push({ page: i, text });
  }
  
  return pages;
};

export const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  
  // Procesar marcadores de página antes de espaciar
  const parts = text.split(/@@PAGE:(\d+)@@/);
  
  const processChunk = (chunk: string, page: number) => {
    let spaced = chunk.replace(/([()[\]{}])/g, ' $1 ');
    // Reparar enroques que vengan separados por espacios en el PDF (ej. O - O)
    spaced = spaced.replace(/O\s*-\s*O\s*-\s*O/g, 'O-O-O');
    spaced = spaced.replace(/O\s*-\s*O/g, 'O-O');
    // Manejar jugadas pegadas al número como 1.e4 -> 1. e4
    spaced = spaced.replace(/(\d+\.+)([A-Za-z])/g, '$1 $2');
    
    // Separar jugadas pegadas tipo e4e5 -> e4 e5
    spaced = spaced.replace(/([a-h][1-8])([a-h][1-8])/g, '$1 $2');
    spaced = spaced.replace(/([RDTAC][a-h][1-8])([RDTAC][a-h][1-8])/g, '$1 $2');
    spaced = spaced.replace(/([RDTAC][a-h][1-8])([a-h][1-8])/g, '$1 $2');
    spaced = spaced.replace(/([a-h][1-8])([RDTAC][a-h][1-8])/g, '$1 $2');
    spaced = spaced.replace(/([a-h]x[a-h][1-8])([a-h]x[a-h][1-8])/g, '$1 $2');
    
    const rawTokens = spaced.split(/\s+/);
    
    for (const t of rawTokens) {
      if (!t) continue;
      
      if (t === '(') { tokens.push({ type: 'ParenOpen', value: '(', page }); continue; }
      if (t === ')') { tokens.push({ type: 'ParenClose', value: ')', page }); continue; }
      
      // Indicadores de movimiento: 1. o 23...
      if (/^\d+\.+$/.test(t)) {
        tokens.push({ type: 'MoveNumber', value: t, page });
        continue;
      }

      // Separar signos de puntuación finales que no sean parte del ajedrez
      const cleanMatch = t.match(/^(.*?)([,;.]+)$/);
      let word = t;
      let trailingPunct = '';
      if (cleanMatch && !SAN_REGEX.test(t)) {
         word = cleanMatch[1];
         trailingPunct = cleanMatch[2];
      }
      
      if (SAN_REGEX.test(word) || CASTLING_REGEX.test(word)) {
         tokens.push({ type: 'SAN', value: word, page });
         if (trailingPunct) tokens.push({ type: 'Text', value: trailingPunct, page });
      } else {
         tokens.push({ type: 'Text', value: t, page });
      }
    }
  };

  if (parts.length === 1) {
    // Sin marcadores de página (texto plano)
    processChunk(parts[0], 1);
  } else {
    // Con marcadores de página
    processChunk(parts[0], 0);
    for (let i = 1; i < parts.length; i += 2) {
      currentPage = parseInt(parts[i], 10);
      tokens.push({ type: 'PageBreak', value: `PAGE:${currentPage}`, page: currentPage });
      if (i + 1 < parts.length) {
        processChunk(parts[i + 1], currentPage);
      }
    }
  }
  
  return tokens;
};

export const translateEsToEn = (sanEs: string): string => {
  if (sanEs.includes('O-O')) return sanEs;
  
  let translated = sanEs.replace(/^([RDTAC])/, (match) => {
    switch (match) {
      case 'R': return 'K';
      case 'D': return 'Q';
      case 'T': return 'R';
      case 'A': return 'B';
      case 'C': return 'N';
      default: return match;
    }
  });
  
  // Promociones c8=D -> c8=Q
  translated = translated.replace(/=([RDTAC])/, (match, p1) => {
    switch (p1) {
      case 'D': return '=Q';
      case 'T': return '=R';
      case 'A': return '=B';
      case 'C': return '=N';
      default: return match;
    }
  });

  return translated;
};

export const translateEnToEs = (sanEn: string): string => {
  if (sanEn.includes('O-O')) return sanEn;
  
  let translated = sanEn.replace(/^[KQBNR]/, (match) => {
    switch (match) {
      case 'K': return 'R';
      case 'Q': return 'D';
      case 'R': return 'T';
      case 'B': return 'A';
      case 'N': return 'C';
      default: return match;
    }
  });
  
  // Promociones
  translated = translated.replace(/=[QRBN]/, (match) => {
    switch (match.charAt(1)) {
      case 'Q': return '=D';
      case 'R': return '=T';
      case 'B': return '=A';
      case 'N': return '=C';
      default: return match;
    }
  });

  return translated;
};

export const parsePGNTree = (tokens: Token[]): ChessState => {
  const nodes: Record<string, GameNode> = {};
  const rootId = uuidv4();
  const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let totalPages = 1;
  
  nodes[rootId] = {
    id: rootId,
    parentId: null,
    childrenIds: [],
    type: 'root',
    sanEs: '',
    sanEn: '',
    fen: STARTING_FEN,
    moveNumber: 0,
    turn: 'w',
    commentBefore: '',
    commentAfter: '',
    isValid: true,
    isMainLine: true,
  };
  
  let currentId = rootId;
  let textBuffer: string[] = [];
  const variationStack: string[] = []
  // lastMoveType rastrea si el último token relevante fue un número de jugada o una jugada.
  // 'none' = todavía no hemos visto nada relevante (inicio o tras texto largo sin número)
  // 'number' = el último token significativo fue un MoveNumber
  // 'move' = el último token significativo fue una SAN válida o inválida
  // 'paren' = acabamos de abrir un paréntesis de variante
  type LastMoveCtx = 'none' | 'number' | 'move' | 'paren';
  let lastMoveCtx: LastMoveCtx = 'none';
  let currentMoveNumber = 1;
  let currentPage = 1;
  
  const flushText = (targetId: string, isBefore = false) => {
    if (textBuffer.length > 0) {
      const text = textBuffer.join(' ');
      if (isBefore) {
        nodes[targetId].commentBefore += (nodes[targetId].commentBefore ? ' ' : '') + text;
      } else {
        nodes[targetId].commentAfter += (nodes[targetId].commentAfter ? ' ' : '') + text;
      }
      textBuffer = [];
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // ── Salto de página ─────────────────────────────────────────────────────
    if (t.type === 'PageBreak') {
      currentPage = t.page ?? currentPage;
      totalPages = Math.max(totalPages, currentPage);
      // Un salto de página NO resetea el tablero. La continuidad se mantiene.
      continue;
    }
    
    if (t.type === 'Text') {
      textBuffer.push(t.value);
      // NO cambiamos lastMoveCtx aquí — el texto no interrumpe la secuencia de jugadas.
      // Esto permite que tras un comentario largo, el siguiente número de jugada
      // todavía active el modo "esperar SAN".
    } else if (t.type === 'MoveNumber') {
      const numMatch = t.value.match(/(\d+)/);
      if (numMatch) {
        currentMoveNumber = parseInt(numMatch[1], 10);
      }
      currentPage = t.page ?? currentPage;

      // ── REGLA DE NUEVA PARTIDA ──────────────────────────────────────────
      // Sólo reiniciamos si vemos "1." o "1..." y ya hay jugadas registradas
      // (es decir, no estamos ya en el nodo raíz vacío).
      // Esto implementa: "Solo reinicia si comienza desde la jugada 1".
      if ((t.value === '1.' || t.value === '1...') && currentId !== rootId && variationStack.length === 0) {
        flushText(currentId, false);
        currentId = rootId;
      }

      lastMoveCtx = 'number';

    } else if (t.type === 'ParenOpen') {
      flushText(currentId, false);
      if (nodes[currentId] && nodes[currentId].parentId) {
        variationStack.push(currentId);
        currentId = nodes[currentId].parentId as string;
      }
      lastMoveCtx = 'paren';
    } else if (t.type === 'ParenClose') {
      flushText(currentId, false);
      if (variationStack.length > 0) {
        currentId = variationStack.pop() as string;
      }
      lastMoveCtx = 'move'; // Tras cerrar variante, seguimos en modo "esperar siguiente jugada"
    } else if (t.type === 'SAN') {
      // ── DECISIÓN: ¿Es esta SAN una jugada real o texto explicativo? ──────
      //
      // Una SAN se considera jugada real si:
      //  a) El contexto inmediato la espera: número de jugada, jugada previa, o apertura de variante.
      //  b) Viene después de texto PERO hay un número de jugada en el contexto (lastMoveCtx === 'number').
      //
      // Una SAN se considera texto si:
      //  c) lastMoveCtx es 'none' (nunca hemos visto ningún número de jugada aún).
      //  d) No hay ningún indicador de jugada en el contexto.
      //
      // NOTA: NO degradamos automáticamente a texto si viene tras comentario.
      // En libros de ajedrez, es común: "...y las negras respondieron 14... Cf6"
      // donde "14..." ya fue procesado como MoveNumber, poniendo lastMoveCtx='number'.
      const canBeMove = lastMoveCtx === 'number' || lastMoveCtx === 'move' || lastMoveCtx === 'paren';
      
      if (!canBeMove) {
        textBuffer.push(t.value);
        continue;
      }

      if (currentId === rootId) {
        flushText(rootId, true);
      } else {
        flushText(currentId, false);
      }
      
      const sanEs = t.value;
      const sanEn = translateEsToEn(sanEs);
      
      let currentExpectedTurn = nodes[currentId].turn;
      const chess = new Chess(nodes[currentId].fen);
      let isValid = false;
      let fen = nodes[currentId].fen;
      let error: string | undefined = undefined;
      
      let move = null;
      try {
        move = chess.move(sanEn);
      } catch {
        // Falló en el turno actual
      }

      if (move) {
        isValid = true;
        fen = chess.fen();
      } else {
        // ¿Era una jugada del otro color? (Falta una jugada en medio)
        const flippedFen = nodes[currentId].fen.replace(
          ` ${currentExpectedTurn} `,
          ` ${currentExpectedTurn === 'w' ? 'b' : 'w'} `
        );
        let validForOther = false;
        try {
          const flippedChess = new Chess(flippedFen);
          validForOther = !!flippedChess.move(sanEn);
        } catch { /* ignore */ }

        if (validForOther) {
          // Detectamos que falta una jugada del color actual
          const missingNodeId = uuidv4();
          const nextTurn = currentExpectedTurn === 'w' ? 'b' : 'w';
          const missingNode: GameNode = {
            id: missingNodeId,
            parentId: currentId,
            childrenIds: [],
            type: 'missing_move',
            sanEs: '???',
            sanEn: '???',
            fen: flippedFen,
            moveNumber: currentMoveNumber,
            turn: nextTurn,
            commentBefore: '',
            commentAfter: ' [Jugada omitida en el PDF] ',
            isValid: false,
            error: 'Falta jugada',
            isMainLine: nodes[currentId].isMainLine && nodes[currentId].childrenIds.length === 0,
            missingColor: currentExpectedTurn,
            playedColor: currentExpectedTurn,
            pageNumber: currentPage,
          };
          nodes[currentId].childrenIds.push(missingNodeId);
          nodes[missingNodeId] = missingNode;
          currentId = missingNodeId;
          
          // Ahora reevaluamos la jugada actual contra el nuevo estado (flipped)
          currentExpectedTurn = nextTurn;
          const flippedChess = new Chess(flippedFen);
          try {
            const retryMove = flippedChess.move(sanEn);
            if (retryMove) {
              isValid = true;
              fen = flippedChess.fen();
              error = undefined;
            }
          } catch {
            error = 'Jugada inválida o fuera de secuencia';
          }
        } else {
          // La jugada es completamente inválida en esta posición para ambos colores.
          // La degradamos a texto para no interrumpir el flujo.
          textBuffer.push(t.value);
          lastMoveCtx = 'none'; // Reset: próxima SAN tampoco puede ser jugada sin número
          continue;
        }
      }
      
      const newNodeId = uuidv4();
      const isMainLine = nodes[currentId].isMainLine && nodes[currentId].childrenIds.length === 0;
      
      const newNode: GameNode = {
        id: newNodeId,
        parentId: currentId,
        childrenIds: [],
        type: 'move',
        sanEs,
        sanEn,
        fen,
        moveNumber: currentMoveNumber,
        turn: isValid ? fen.split(' ')[1] as 'w' | 'b' : currentExpectedTurn,
        playedColor: currentExpectedTurn,
        commentBefore: '',
        commentAfter: '',
        isValid,
        error,
        isMainLine,
        pageNumber: currentPage,
      };
      
      nodes[currentId].childrenIds.push(newNodeId);
      nodes[newNodeId] = newNode;
      
      currentId = newNodeId;
      lastMoveCtx = 'move';
    }
  }
  
  flushText(currentId, false);
  
  return { nodes, rootId, totalPages };
};
