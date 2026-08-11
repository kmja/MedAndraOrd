// The English word bank. Hand-authored — writing the forbidden lists is the
// Taboo craft, and each list blocks the most obvious clue routes for its word.
//
// CHOSEN ON TWO MEASURED PROPERTIES, after a first pass was authored on taste
// and turned out to be far too easy. Run `npm run density` to see them.
//
//   RIVALS — how many same-length words share a parent in WordNet. The guesser
//   is told the letter count and the word class, so a target with no
//   same-length relatives can be reached by pointing roughly at its area. The
//   first bank had a MEDIAN OF ZERO: 34 of 52 scorable words had nowhere else
//   a category clue could land. This one has a median of 21.
//
//   POLYSEMY — several live senses. crane is a bird, a machine and something
//   you do with your neck; spring is a season, a coil, a water source and a
//   jump. That is the crossword device, and it gives the player something to be
//   clever WITH rather than merely something to describe.
//
// The counter-intuitive part, and the reason the first bank failed: specific,
// unusual words score WORSE, not better. lighthouse, orchard, windmill
// and telescope all have zero rivals — being specific shrinks the answer
// space, and a small answer space is what makes the guesser's job easy.
//
// The metric selects for abstraction if you let it lead (work, turn,
// point top the list), so the division of labour is: judgment proposes
// concrete everyday words, the measurement filters them. Neither alone
// produced a usable bank.
//
// Every target here is checked by the tests: a real word AND a lemma in
// server/data/en-*.txt, absent from the English prompt, labelled with a word
// class WordNet agrees with, and carrying a forbidden list.
//
// Not yet calibrated against the model. The per-word `limit` the Swedish bank
// carries comes from probe runs; English has had none, so every word falls
// back to the global default and the limits are probably too generous.
export const WORDS = [
  { word: 'barrel', forbidden: ['cask', 'keg', 'wine', 'gun', 'cylinder'] },
  { word: 'bank', forbidden: ['money', 'river', 'savings', 'teller', 'slope'] },
  { word: 'bark', forbidden: ['tree', 'dog', 'canine', 'timber', 'yelp'] },
  { word: 'board', forbidden: ['plank', 'wood', 'committee', 'chess', 'embark'] },
  { word: 'bridge', forbidden: ['cross', 'span', 'arch', 'roadway', 'dental'] },
  { word: 'brush', forbidden: ['bristle', 'paint', 'sweep', 'thicket', 'hair'] },
  { word: 'cast', forbidden: ['throw', 'mould', 'actor', 'plaster', 'fishing'] },
  { word: 'chamber', forbidden: ['room', 'heart', 'gun', 'council', 'cavity'] },
  { word: 'channel', forbidden: ['water', 'broadcast', 'strait', 'groove', 'route'] },
  { word: 'charm', forbidden: ['spell', 'bracelet', 'magic', 'allure', 'luck'] },
  { word: 'clip', forbidden: ['fasten', 'paper', 'shorten', 'film', 'staple'] },
  { word: 'counter', forbidden: ['kitchen', 'shop', 'oppose', 'tally', 'desk'] },
  { word: 'court', forbidden: ['tennis', 'royal', 'judge', 'woo', 'yard'] },
  { word: 'crane', forbidden: ['bird', 'lift', 'neck', 'stork', 'construction'] },
  { word: 'crown', forbidden: ['king', 'head', 'tooth', 'royal', 'tiara'] },
  { word: 'dock', forbidden: ['harbour', 'boat', 'court', 'wharf', 'pier'] },
  { word: 'dragon', forbidden: ['fire', 'myth', 'scale', 'beast', 'lizard'] },
  { word: 'drum', forbidden: ['beat', 'percussion', 'barrel', 'stick', 'rhythm'] },
  { word: 'fork', forbidden: ['cutlery', 'road', 'prong', 'branch', 'split'] },
  { word: 'frame', forbidden: ['picture', 'border', 'skeleton', 'structure', 'window'] },
  { word: 'glass', forbidden: ['window', 'drink', 'transparent', 'tumbler', 'lens'] },
  { word: 'grain', forbidden: ['wheat', 'wood', 'seed', 'cereal', 'texture'] },
  { word: 'hammer', forbidden: ['nail', 'tool', 'strike', 'carpenter', 'mallet'] },
  { word: 'horn', forbidden: ['animal', 'brass', 'trumpet', 'antler', 'honk'] },
  { word: 'kettle', forbidden: ['boil', 'spout', 'teapot', 'whistle', 'water'] },
  { word: 'lock', forbidden: ['key', 'door', 'canal', 'hair', 'secure'] },
  { word: 'match', forbidden: ['fire', 'game', 'pair', 'strike', 'contest'] },
  { word: 'mint', forbidden: ['herb', 'coin', 'fresh', 'sweet', 'money'] },
  { word: 'nail', forbidden: ['hammer', 'finger', 'spike', 'claw', 'fasten'] },
  { word: 'needle', forbidden: ['thread', 'sew', 'sharp', 'pine', 'syringe'] },
  { word: 'palm', forbidden: ['hand', 'tree', 'tropical', 'frond', 'fist'] },
  { word: 'pattern', forbidden: ['repeat', 'design', 'template', 'motif', 'habit'] },
  { word: 'pitch', forbidden: ['throw', 'field', 'sound', 'tar', 'sales'] },
  { word: 'plane', forbidden: ['fly', 'tool', 'flat', 'aircraft', 'wing'] },
  { word: 'plant', forbidden: ['grow', 'factory', 'garden', 'seed', 'vegetation'] },
  { word: 'plate', forbidden: ['dish', 'dinner', 'metal', 'armour', 'tectonic'] },
  { word: 'pool', forbidden: ['swim', 'water', 'billiard', 'puddle', 'shared'] },
  { word: 'post', forbidden: ['mail', 'pole', 'job', 'letter', 'fence'] },
  { word: 'ring', forbidden: ['finger', 'bell', 'circle', 'boxing', 'jewel'] },
  { word: 'root', forbidden: ['tree', 'origin', 'dig', 'radish', 'source'] },
  { word: 'saddle', forbidden: ['horse', 'ride', 'leather', 'stirrup', 'burden'] },
  { word: 'scale', forbidden: ['weigh', 'fish', 'music', 'climb', 'measure'] },
  { word: 'screen', forbidden: ['display', 'hide', 'monitor', 'filter', 'window'] },
  { word: 'seal', forbidden: ['animal', 'close', 'stamp', 'envelope', 'flipper'] },
  { word: 'section', forbidden: ['part', 'divide', 'slice', 'chapter', 'segment'] },
  { word: 'shell', forbidden: ['snail', 'beach', 'bomb', 'husk', 'crustacean'] },
  { word: 'slide', forbidden: ['slip', 'playground', 'glass', 'chute', 'descend'] },
  { word: 'spring', forbidden: ['season', 'coil', 'water', 'jump', 'bounce'] },
  { word: 'stamp', forbidden: ['mail', 'foot', 'seal', 'postage', 'imprint'] },
  { word: 'stem', forbidden: ['flower', 'stalk', 'originate', 'glass', 'plant'] },
  { word: 'stick', forbidden: ['wood', 'glue', 'branch', 'adhere', 'cane'] },
  { word: 'temple', forbidden: ['worship', 'head', 'shrine', 'forehead', 'sacred'] },
  { word: 'tide', forbidden: ['sea', 'moon', 'ebb', 'flood', 'current'] },
  { word: 'track', forbidden: ['railway', 'follow', 'trail', 'running', 'record'] },
  { word: 'trunk', forbidden: ['tree', 'elephant', 'luggage', 'torso', 'car'] },
  { word: 'wave', forbidden: ['sea', 'hand', 'greet', 'ripple', 'radio'] },
  { word: 'wheel', forbidden: ['turn', 'car', 'spoke', 'circle', 'steer'] },
  { word: 'window', forbidden: ['glass', 'pane', 'view', 'frame', 'opportunity'] },
  { word: 'crack', forbidden: ['break', 'split', 'fissure', 'joke', 'whip'], class: 'verb' },
  { word: 'drift', forbidden: ['float', 'snow', 'wander', 'current', 'aimless'], class: 'verb' },
  { word: 'gather', forbidden: ['collect', 'assemble', 'harvest', 'crowd', 'accumulate'], class: 'verb' },
  { word: 'linger', forbidden: ['remain', 'delay', 'dawdle', 'loiter', 'stay'], class: 'verb' },
  { word: 'scatter', forbidden: ['spread', 'disperse', 'strew', 'sprinkle', 'apart'], class: 'verb' },
  { word: 'settle', forbidden: ['sink', 'resolve', 'inhabit', 'calm', 'sediment'], class: 'verb' },
  { word: 'sweep', forbidden: ['broom', 'clean', 'curve', 'victory', 'chimney'], class: 'verb' },
  { word: 'wander', forbidden: ['roam', 'stroll', 'ramble', 'meander', 'aimless'], class: 'verb' },
];
