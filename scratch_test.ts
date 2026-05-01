import { tokenize, parsePGNTree } from './src/lib/chessParser';

const text = "11. Te1 Dc7 12. Ab3 Las negras ahora deben decidir cómo continuar. Una idea común es jugar: exd4 Cxd4 Pero esto puede llevar";
const tokens = tokenize(text);
console.log(JSON.stringify(tokens, null, 2));
