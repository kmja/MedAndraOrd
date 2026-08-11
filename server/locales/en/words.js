// The English word bank. Hand-authored — writing the forbidden lists is the
// Taboo craft, and each list blocks the most obvious clue routes for its word.
//
// Sixty words: two months of daily play. Deliberately small. The forbidden
// lists are where this game is won or lost, and three consecutive days of live
// Swedish play each turned up a route the list had missed — so a short bank
// that can be corrected from real play beats a long one authored blind.
//
// Every target here is checked against three things by the tests: it is a real
// word in server/data/en-words-*.txt, it does NOT appear anywhere in the
// English prompt (a target named in the rulebook is a target the guesser can
// reach for on a vague clue), and it carries a forbidden list of its own.
//
// Verbs are listed in the infinitive without to; adjectives in the positive
// degree. Everything unlabelled is a noun — see LOCALE.defaultWordClass.
//
// The rotation in ./rotation.js is a permutation of THIS array's indices. The
// two must be replaced as a pair, or the calendar silently repoints.
//
// Not yet calibrated. The per-word `limit` that the Swedish bank carries comes
// from probe runs, and English has had none — the model is markedly stronger in
// English, so the clue limits almost certainly want to be tighter here. Until
// then every word falls back to the global default.

export const WORDS = [
  { word: 'anchor', forbidden: ['ship', 'harbour', 'heavy', 'chain', 'seabed'] },
  { word: 'basket', forbidden: ['carry', 'weave', 'handle', 'picnic', 'basketball'] },
  { word: 'bridge', forbidden: ['cross', 'water', 'span', 'arch', 'roadway'] },
  { word: 'candle', forbidden: ['flame', 'wick', 'melt', 'birthday', 'candlelight'] },
  { word: 'desert', forbidden: ['sand', 'camel', 'thirst', 'dune', 'arid'] },
  { word: 'dragon', forbidden: ['fire', 'myth', 'scale', 'wing', 'beast'] },
  { word: 'engine', forbidden: ['motor', 'power', 'machine', 'piston', 'engineer'] },
  { word: 'forest', forbidden: ['tree', 'wood', 'green', 'timber', 'undergrowth'] },
  { word: 'garden', forbidden: ['plant', 'flower', 'grow', 'soil', 'gardener'] },
  { word: 'hammer', forbidden: ['nail', 'tool', 'strike', 'carpenter', 'mallet'] },
  { word: 'helmet', forbidden: ['head', 'protect', 'cycle', 'visor', 'armour'] },
  { word: 'island', forbidden: ['surrounded', 'shore', 'ocean', 'isolated', 'archipelago'] },
  { word: 'jacket', forbidden: ['coat', 'sleeve', 'zipper', 'garment', 'outerwear'] },
  { word: 'jungle', forbidden: ['tropical', 'dense', 'vine', 'monkey', 'rainforest'] },
  { word: 'kettle', forbidden: ['boil', 'spout', 'water', 'teapot', 'whistle'] },
  { word: 'ladder', forbidden: ['climb', 'rung', 'reach', 'step', 'scaffold'] },
  { word: 'lantern', forbidden: ['light', 'glow', 'carry', 'paraffin', 'lamplight'] },
  { word: 'magnet', forbidden: ['attract', 'iron', 'pull', 'north', 'magnetic'] },
  { word: 'mirror', forbidden: ['reflect', 'glass', 'image', 'looking', 'reflection'] },
  { word: 'needle', forbidden: ['sharp', 'thread', 'sew', 'point', 'stitch'] },
  { word: 'orchard', forbidden: ['apple', 'tree', 'fruit', 'grove', 'harvest'] },
  { word: 'palace', forbidden: ['king', 'royal', 'grand', 'throne', 'monarch'] },
  { word: 'pebble', forbidden: ['stone', 'small', 'beach', 'smooth', 'gravel'] },
  { word: 'pumpkin', forbidden: ['orange', 'seed', 'halloween', 'gourd', 'lantern'] },
  { word: 'puzzle', forbidden: ['solve', 'piece', 'jigsaw', 'riddle', 'brainteaser'] },
  { word: 'rabbit', forbidden: ['burrow', 'carrot', 'hutch', 'warren', 'whiskers'] },
  { word: 'rocket', forbidden: ['space', 'launch', 'thrust', 'orbit', 'spacecraft'] },
  { word: 'saddle', forbidden: ['horse', 'ride', 'leather', 'stirrup', 'harness'] },
  { word: 'shadow', forbidden: ['light', 'cast', 'dark', 'silhouette', 'shade'] },
  { word: 'statue', forbidden: ['stone', 'sculpture', 'monument', 'pedestal', 'bronze'] },
  { word: 'thunder', forbidden: ['lightning', 'storm', 'rumble', 'cloud', 'thunderstorm'] },
  { word: 'tunnel', forbidden: ['dig', 'underground', 'passage', 'bore', 'excavate'] },
  { word: 'wallet', forbidden: ['money', 'card', 'leather', 'cash', 'billfold'] },
  { word: 'window', forbidden: ['glass', 'pane', 'view', 'frame', 'windowsill'] },
  { word: 'gather', forbidden: ['collect', 'assemble', 'together', 'harvest', 'accumulate'], class: 'verb' },
  { word: 'linger', forbidden: ['remain', 'delay', 'stay', 'dawdle', 'loiter'], class: 'verb' },
  { word: 'polish', forbidden: ['shine', 'rub', 'gloss', 'buff', 'lustre'], class: 'verb' },
  { word: 'scatter', forbidden: ['spread', 'disperse', 'strew', 'apart', 'sprinkle'], class: 'verb' },
  { word: 'shiver', forbidden: ['cold', 'tremble', 'shake', 'chill', 'quiver'], class: 'verb' },
  { word: 'stumble', forbidden: ['trip', 'fall', 'clumsy', 'totter', 'falter'], class: 'verb' },
  { word: 'wander', forbidden: ['roam', 'stroll', 'aimless', 'ramble', 'meander'], class: 'verb' },
  { word: 'whisper', forbidden: ['quiet', 'murmur', 'softly', 'hush', 'undertone'], class: 'verb' },
  { word: 'brittle', forbidden: ['fragile', 'snap', 'crack', 'breakable', 'delicate'], class: 'adjective' },
  { word: 'gentle', forbidden: ['soft', 'kind', 'mild', 'tender', 'soothing'], class: 'adjective' },
  { word: 'hollow', forbidden: ['empty', 'cavity', 'inside', 'void', 'echoing'], class: 'adjective' },
  { word: 'narrow', forbidden: ['thin', 'tight', 'slender', 'cramped', 'constricted'], class: 'adjective' },
  { word: 'rugged', forbidden: ['rough', 'harsh', 'craggy', 'terrain', 'weathered'], class: 'adjective' },
  { word: 'tender', forbidden: ['soft', 'gentle', 'sore', 'affectionate', 'delicate'], class: 'adjective' },
  { word: 'vivid', forbidden: ['bright', 'colour', 'striking', 'intense', 'brilliant'], class: 'adjective' },
  { word: 'frosty', forbidden: ['cold', 'ice', 'chill', 'freezing', 'wintry'], class: 'adjective' },
  { word: 'chalk', forbidden: ['board', 'white', 'dust', 'blackboard', 'limestone'] },
  { word: 'ember', forbidden: ['fire', 'glow', 'coal', 'smoulder', 'ashes'] },
  { word: 'torch', forbidden: ['beam', 'flame', 'battery', 'flashlight', 'lantern'] },
  { word: 'quilt', forbidden: ['bed', 'stitch', 'patchwork', 'blanket', 'coverlet'] },
  { word: 'maple', forbidden: ['tree', 'syrup', 'leaf', 'canada', 'sapling'] },
  { word: 'pearl', forbidden: ['oyster', 'necklace', 'lustre', 'gemstone', 'iridescent'] },
  { word: 'anvil', forbidden: ['blacksmith', 'iron', 'forge', 'metal', 'smithy'] },
  { word: 'globe', forbidden: ['sphere', 'world', 'atlas', 'round', 'cartography'] },
  { word: 'windmill', forbidden: ['wind', 'blade', 'grind', 'flour', 'turbine'] },
  { word: 'scaffold', forbidden: ['build', 'platform', 'construction', 'framework', 'pole'] },
];
