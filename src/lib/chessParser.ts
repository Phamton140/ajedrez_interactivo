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
}

export interface ChessState {
  nodes: Record<string, GameNode>;
  rootId: string;
}

export type TokenType = 'MoveNumber' | 'SAN' | 'ParenOpen' | 'ParenClose' | 'NAG' | 'Text';

export interface Token {
  type: TokenType;
  value: string;
}

const SAN_REGEX = /^([RDTAC])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([RDTAC]))?([+#]?)([\?!]*)$/;
const CASTLING_REGEX = /^O-O(-O)?([+#]?)([\?!]*)$/;

export const extractTextFromPdf = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += pageText + ' \n ';
  }
  
  return fullText;
};

export const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  
  let spaced = text.replace(/([()\[\]{}])/g, ' $1 ');
  // Reparar enroques que vengan separados por espacios en el PDF (ej. O - O)
  spaced = spaced.replace(/O\s*-\s*O\s*-\s*O/g, 'O-O-O');
  spaced = spaced.replace(/O\s*-\s*O/g, 'O-O');
  // Manejar jugadas pegadas al número como 1.e4 -> 1. e4
  spaced = spaced.replace(/(\d+\.+)([A-Za-z])/g, '$1 $2');
  
  // Separar jugadas pegadas tipo e4e5 -> e4 e5
  spaced = spaced.replace(/([a-h][1-8])([a-h][1-8])/g, '$1 $2'); // e4e5
  spaced = spaced.replace(/([RDTAC][a-h][1-8])([RDTAC][a-h][1-8])/g, '$1 $2'); // Cf3Cc6
  spaced = spaced.replace(/([RDTAC][a-h][1-8])([a-h][1-8])/g, '$1 $2'); // Ab5a6
  spaced = spaced.replace(/([a-h][1-8])([RDTAC][a-h][1-8])/g, '$1 $2'); // e4Cf6
  spaced = spaced.replace(/([a-h]x[a-h][1-8])([a-h]x[a-h][1-8])/g, '$1 $2'); // exd5cxd5
  
  const rawTokens = spaced.split(/\s+/);
  
  for (let t of rawTokens) {
    if (!t) continue;
    
    if (t === '(') { tokens.push({ type: 'ParenOpen', value: '(' }); continue; }
    if (t === ')') { tokens.push({ type: 'ParenClose', value: ')' }); continue; }
    
    // Indicadores de movimiento: 1. o 23...
    if (/^\d+\.+$/.test(t)) {
      tokens.push({ type: 'MoveNumber', value: t });
      continue;
    }

    // Separar signos de puntuación finales que no sean parte del ajedrez
    const cleanMatch = t.match(/^(.*?)([,;.]+)$/);
    let word = t;
    let trailingPunct = '';
    if (cleanMatch && !SAN_REGEX.test(t)) {
       // Si no es SAN completo, extraemos la puntuación
       word = cleanMatch[1];
       trailingPunct = cleanMatch[2];
    }
    
    if (SAN_REGEX.test(word) || CASTLING_REGEX.test(word)) {
       tokens.push({ type: 'SAN', value: word });
       if (trailingPunct) tokens.push({ type: 'Text', value: trailingPunct });
    } else {
       tokens.push({ type: 'Text', value: t });
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

export const parsePGNTree = (tokens: Token[]): ChessState => {
  const nodes: Record<string, GameNode> = {};
  const rootId = uuidv4();
  
  nodes[rootId] = {
    id: rootId,
    parentId: null,
    childrenIds: [],
    type: 'root',
    sanEs: '',
    sanEn: '',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveNumber: 0,
    turn: 'w',
    commentBefore: '',
    commentAfter: '',
    isValid: true,
    isMainLine: true,
  };
  
  let currentId = rootId;
  let textBuffer: string[] = [];
  const variationStack: string[] = [];
  let lastProcessedType: TokenType | null = null;
  let currentMoveNumber = 1;
  
  const flushText = (targetId: string, isBefore: boolean = false) => {
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
    
    if (t.type === 'Text') {
      textBuffer.push(t.value);
      lastProcessedType = 'Text';
    } else if (t.type === 'MoveNumber') {
      lastProcessedType = 'MoveNumber';
      const numMatch = t.value.match(/(\d+)/);
      if (numMatch) {
        const parsedNum = parseInt(numMatch[1], 10);
        
        // Detectar si hay un salto enorme en el número de jugada (mayor a 1)
        // Esto indica que el autor saltó a otro ejemplo o partida en el texto.
        if (currentId !== rootId) {
          const parentMoveNum = nodes[currentId].moveNumber;
          // Ignoramos el salto si el parentMoveNum es 0 (root) o si es solo 1 de diferencia.
          if (parentMoveNum > 0 && Math.abs(parsedNum - parentMoveNum) > 1) {
            flushText(currentId, false);
            currentId = rootId;
          }
        }
        
        currentMoveNumber = parsedNum;
      }
      // Si encontramos "1." o "1...", asumimos que empieza una nueva partida/capítulo
      if (t.value === '1.' || t.value === '1...') {
        flushText(currentId, false);
        currentId = rootId;
      }
    } else if (t.type === 'ParenOpen') {
      flushText(currentId, false);
      if (nodes[currentId] && nodes[currentId].parentId) {
        variationStack.push(currentId);
        currentId = nodes[currentId].parentId as string;
      }
      lastProcessedType = 'ParenOpen';
    } else if (t.type === 'ParenClose') {
      flushText(currentId, false);
      if (variationStack.length > 0) {
        currentId = variationStack.pop() as string;
      }
      lastProcessedType = 'ParenClose';
    } else if (t.type === 'SAN') {
      // Solo es una jugada si viene después de un número de jugada, apertura de variante, u otra jugada.
      // Si viene después de texto, es solo un comentario que parece jugada (ej. "d4").
      const canBeMove = lastProcessedType === 'MoveNumber' || lastProcessedType === 'SAN' || lastProcessedType === 'ParenOpen';
      
      if (!canBeMove) {
        textBuffer.push(t.value);
        lastProcessedType = 'Text';
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
      let error = undefined;
      
      let move = null;
      try {
        move = chess.move(sanEn);
      } catch (e: any) {
        // Falló en el turno actual
      }

      if (move) {
        isValid = true;
        fen = chess.fen();
      } else {
        // ¿Era una jugada del otro color? (Falta una jugada en medio)
        const flippedFen = nodes[currentId].fen.replace(` ${currentExpectedTurn} `, ` ${currentExpectedTurn === 'w' ? 'b' : 'w'} `);
        let validForOther = false;
        try {
          const flippedChess = new Chess(flippedFen);
          validForOther = !!flippedChess.move(sanEn);
        } catch (e) {}

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
            playedColor: currentExpectedTurn
          };
          nodes[currentId].childrenIds.push(missingNodeId);
          nodes[missingNodeId] = missingNode;
          currentId = missingNodeId; // Avanzamos al nodo faltante
          
          // Ahora reevaluamos la jugada actual contra el nuevo estado (flipped)
          currentExpectedTurn = nextTurn;
          const flippedChess = new Chess(flippedFen);
          try {
            const retryMove = flippedChess.move(sanEn);
            if (retryMove) {
              isValid = true;
              fen = flippedChess.fen();
              error = undefined; // El error era por la jugada anterior
            }
          } catch (e) {
            error = 'Jugada inválida o fuera de secuencia';
          }
        } else {
          // La jugada es completamente inválida en esta posición para ambos colores.
          // Es muy probable que sea texto explicativo usando notación (ej. "una idea es exd4").
          // Lo degradamos a texto normal. Si era una jugada real con error tipográfico, 
          // la siguiente jugada real provocará un desajuste de turno y generará un '???'.
          textBuffer.push(t.value);
          lastProcessedType = 'Text';
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
      };
      
      nodes[currentId].childrenIds.push(newNodeId);
      nodes[newNodeId] = newNode;
      
      currentId = newNodeId;
      lastProcessedType = 'SAN';
    }
  }
  
  flushText(currentId, false);
  
  return { nodes, rootId };
};
