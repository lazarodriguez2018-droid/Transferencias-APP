/*
 * Buscador inteligente de Sucaneitor Inventario.
 *
 * No depende del servidor: funciona tanto online como offline. Se expone como
 * window.SucaneitorSearch en el navegador y como módulo CommonJS para pruebas.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SucaneitorSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SESSION_STOP_WORDS = new Set([
    'stock', 'inventario', 'conteo', 'control', 'sucursal', 'deposito',
    'pde', 'mdo', 'cen', 'cda', 'cde', 'pc', 'tablet', 'prueba', 'nuevo',
    'nuevos', 'nueva', 'nuevas', 'para', 'del', 'de', 'la', 'el', 'los',
    'las', 'y', 'en', 'por'
  ]);

  const CATEGORY_RULES = [
    { id: 'humedos', label: 'Húmedos', terms: ['humedo', 'wet food', 'sachet', 'pouch', 'sobre', 'lata', 'paté', 'pate'] },
    { id: 'snacks', label: 'Snacks', terms: ['snack', 'treat', 'premio', 'masticable', 'hueso', 'bone', 'barrita', 'barra funcional'] },
    { id: 'chapitas', label: 'Chapitas', terms: ['chapita', 'tag', 'identificador', 'medalla'] },
    { id: 'higiene', label: 'Higiene', terms: ['shampoo', 'champu', 'conditioner', 'acondicionador', 'perfume', 'higiene', 'toallita', 'wipes'] },
    { id: 'arenas', label: 'Arenas', terms: ['arena', 'litter', 'sanitario', 'piedra sanitaria'] },
    { id: 'accesorios', label: 'Accesorios', terms: ['accesorio', 'collar', 'correa', 'leash', 'pretal', 'harness', 'juguete', 'toy', 'peluche', 'cama', 'bed', 'comedero', 'bowl', 'bebedero', 'transportadora', 'carrier', 'rascador', 'scratcher', 'bozal', 'muzzle', 'ropa'] },
    { id: 'farmacia', label: 'Farmacia', terms: ['antiparasitario', 'pipeta', 'comprimido', 'medicamento', 'spray', 'collar antipulgas', 'flea', 'tick'] },
    { id: 'raciones', label: 'Raciones', terms: ['racion', 'alimento', 'food', 'adulto', 'adult', 'cachorro', 'puppy', 'kitten', 'baby', 'senior', 'kg'] }
  ];

  // Equivalencias presentes en el padrón. Se incluyen plurales, géneros y las
  // abreviaturas que realmente se usan durante el conteo. Las coincidencias por
  // traducción reciben menos puntaje que una palabra escrita tal cual aparece.
  const SYNONYM_GROUPS = [
    ['adult', 'adulto', 'adulta', 'adultos', 'adultas', 'ad', 'adu'],
    ['puppy', 'cachorro', 'cachorra', 'cachorros', 'cachorras', 'cach'],
    ['kitten', 'gatito', 'gatita', 'gatitos', 'gatitas'],
    ['baby', 'bebe', 'bebes'],
    ['junior', 'joven', 'jovenes'],
    ['senior', 'mature', 'mayor', 'mayores', 'maduro', 'maduros'],
    ['dog', 'dogs', 'perro', 'perros', 'canino', 'caninos'],
    ['cat', 'cats', 'gato', 'gatos', 'felino', 'felinos'],
    ['small', 'mini', 'pequeno', 'pequena', 'pequenos', 'pequenas', 'chico', 'chica', 'peq', 's', 'xs', 'xxs'],
    ['medium', 'mediano', 'mediana', 'medianos', 'medianas', 'med', 'm'],
    ['large', 'maxi', 'grande', 'grandes', 'gde', 'l', 'xl', 'xxl'],
    ['giant', 'gigante', 'gigantes'],
    ['breed', 'breeds', 'raza', 'razas'],

    ['black', 'negro', 'negra', 'negros', 'negras'],
    ['white', 'blanco', 'blanca', 'blancos', 'blancas'],
    ['red', 'rojo', 'roja', 'rojos', 'rojas'],
    ['blue', 'azul', 'azules'],
    ['green', 'verde', 'verdes'],
    ['orange', 'naranja', 'naranjas'],
    ['pink', 'rosa', 'rosado', 'rosada', 'rosados', 'rosadas'],
    ['yellow', 'amarillo', 'amarilla', 'amarillos', 'amarillas'],
    ['purple', 'violet', 'violeta', 'morado', 'morada', 'lila', 'lilac'],
    ['brown', 'marron', 'marrones'],
    ['gray', 'grey', 'gris', 'grises'],
    ['turquoise', 'turquesa'],
    ['dark', 'oscuro', 'oscura'],
    ['navy', 'azul marino'],

    ['chicken', 'pollo'],
    ['lamb', 'cordero'],
    ['beef', 'carne', 'vacuno', 'res'],
    ['turkey', 'pavo'],
    ['duck', 'pato'],
    ['pork', 'cerdo', 'panceta', 'tocino'],
    ['fish', 'pescado', 'pescados'],
    ['tuna', 'tonno', 'atun'],
    ['rabbit', 'conejo'],
    ['boar', 'jabali'],
    ['cod', 'bacalao'],
    ['trout', 'trucha'],
    ['rice', 'arroz'],
    ['grain', 'grains', 'cereal', 'cereales', 'grano', 'granos'],
    ['oat', 'oats', 'avena'],
    ['apple', 'manzana'],
    ['raspberry', 'raspberries', 'frambuesa', 'frambuesas'],
    ['blueberry', 'blueberries', 'arandano', 'arandanos'],
    ['cranberry', 'cranberries', 'arandano rojo', 'arandanos rojos'],
    ['fruit', 'fruits', 'fruta', 'frutas'],
    ['vegetable', 'vegetables', 'veg', 'vegetal', 'vegetales', 'verdura', 'verduras'],
    ['milk', 'leche'],
    ['liver', 'higado', 'hepatico', 'hepatica'],
    ['flavor', 'flavour', 'sabor'],
    ['scent', 'aroma'],

    ['food', 'alimento', 'alimentos', 'comida', 'racion', 'raciones'],
    ['treat', 'treats', 'snack', 'snacks', 'premio', 'premios'],
    ['toy', 'toys', 'juguete', 'juguetes'],
    ['ball', 'balls', 'pelota', 'pelotas'],
    ['bone', 'bones', 'hueso', 'huesos'],
    ['bowl', 'bowls', 'comedero', 'comederos'],
    ['bed', 'beds', 'cama', 'camas'],
    ['leash', 'leashes', 'correa', 'correas'],
    ['harness', 'harnesses', 'arnes', 'arneses', 'pechera', 'pecheras', 'pretal', 'pretales'],
    ['brush', 'brushes', 'cepillo', 'cepillos'],
    ['pad', 'pads', 'panal', 'panales', 'empapador', 'empapadores'],
    ['carrier', 'carriers', 'transportadora', 'transportadoras', 'transportador', 'transportadores'],
    ['scratcher', 'scratchers', 'rascador', 'rascadores'],
    ['litter', 'arena', 'arenas', 'sanitario', 'sanitaria'],
    ['pouch', 'sachet', 'sobre', 'sobres'],
    ['canned', 'enlatado', 'enlatada', 'lata', 'latas'],
    ['wet', 'humedo', 'humeda', 'humedos', 'humedas'],
    ['dry', 'seco', 'seca', 'secos', 'secas'],
    ['rubber', 'goma'],
    ['rope', 'cuerda', 'cuerdas'],
    ['mesh', 'malla'],
    ['steel', 'acero'],
    ['aluminum', 'aluminium', 'aluminio'],
    ['reflective', 'reflectivo', 'reflectiva'],
    ['waterproof', 'impermeable'],
    ['soft', 'suave'],
    ['slow', 'lento', 'lenta'],
    ['training', 'entrenamiento', 'adiestramiento'],
    ['walk', 'walking', 'paseo'],
    ['indoor', 'interior'],
    ['outdoor', 'exterior'],
    ['wipes', 'toallita', 'toallitas'],
    ['bottle', 'botella'],
    ['dispenser', 'dispensador'],
    ['mat', 'alfombra'],
    ['bag', 'bags', 'bolsa', 'bolsas', 'bolsita', 'bolsitas'],
    ['poop', 'heces', 'caca', 'residuos'],
    ['scoop', 'pala'],
    ['house', 'casa', 'casita'],
    ['sweater', 'buzo'],
    ['jacket', 'campera', 'chaqueta'],
    ['muzzle', 'bozal'],
    ['tag', 'tags', 'chapita', 'chapitas', 'medalla', 'medallas', 'identificador'],
    ['flea', 'fleas', 'pulga', 'pulgas', 'antipulgas'],
    ['tick', 'ticks', 'garrapata', 'garrapatas'],

    ['skin', 'piel'],
    ['hair', 'pelo'],
    ['sterilised', 'sterilized', 'neutered', 'castrado', 'castrada', 'castrados', 'castradas', 'esterilizado', 'esterilizada'],
    ['weight', 'peso'],
    ['loss', 'perdida'],
    ['sensitive', 'sensible', 'sensibilidad'],
    ['digestive', 'digestion', 'digestivo', 'digestiva', 'gastro'],
    ['urinary', 'urinario', 'urinaria'],
    ['dental', 'oral', 'diente', 'dientes', 'bucal'],
    ['light', 'liviano', 'liviana', 'claro', 'clara'],
    ['healthy', 'saludable'],
    ['kidney', 'rinon', 'rinones', 'renal'],
    ['cardiac', 'cardiaco', 'cardiaca'],
    ['joint', 'joints', 'articulacion', 'articulaciones'],
    ['mobility', 'movilidad'],
    ['calm', 'calming', 'calma', 'tranquilo', 'tranquila'],
    ['hypoallergenic', 'hypoallergy', 'allergy', 'hipoalergenico', 'hipoalergenica', 'alergia'],
    ['clean', 'limpio', 'limpia', 'limpieza'],
    ['recipe', 'receta']
  ];

  const PHRASE_GROUPS = [
    ['sin cereales', 'sin cereal', 'sin granos', 'sin grano', 'grain free', 'grains free'],
    ['bola de pelo', 'bolas de pelo', 'hair ball', 'hairball'],
    ['todas las razas', 'todo tipo de raza', 'all breeds'],
    ['control de peso', 'weight control', 'weight care'],
    ['perdida de peso', 'bajar de peso', 'weight loss'],
    ['piel sensible', 'sensitive skin'],
    ['bano seco', 'dry bath', 'dry bathing'],
    ['alimento humedo', 'comida humeda', 'wet food'],
    ['alimento seco', 'comida seca', 'dry food'],
    ['dieta veterinaria', 'dietas veterinarias', 'veterinary diet', 'veterinary diets'],
    ['azul marino', 'navy'],
    ['arandano rojo', 'arandanos rojos', 'cranberry', 'cranberries'],
    ['te verde', 'green tea']
  ];

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/([a-z])([0-9])/g, '$1 $2')
      .replace(/([0-9])([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function compactText(value) {
    return normalizeText(value).replace(/\s+/g, '');
  }

  function tokenize(value) {
    const normalized = normalizeText(value);
    return normalized ? normalized.split(' ').filter(Boolean) : [];
  }

  const SYNONYM_LOOKUP = (() => {
    const lookup = new Map();
    for (const rawGroup of SYNONYM_GROUPS) {
      const group = [...new Set(rawGroup.map(normalizeText).filter(Boolean))];
      for (const term of group) lookup.set(term, group);
    }
    return lookup;
  })();

  function getSynonyms(term) {
    const normalized = normalizeText(term);
    return (SYNONYM_LOOKUP.get(normalized) || []).filter(value => value !== normalized);
  }

  function replacePhrase(text, source, replacement) {
    const padded = ` ${text} `;
    const marker = ` ${source} `;
    if (!padded.includes(marker)) return null;
    return padded.split(marker).join(` ${replacement} `).trim().replace(/\s+/g, ' ');
  }

  function expandQueryPhrases(queryNorm) {
    const variants = [{ value: queryNorm, penalty: 0 }];
    const seen = new Set([queryNorm]);
    for (const rawGroup of PHRASE_GROUPS) {
      const group = rawGroup.map(normalizeText);
      const snapshot = variants.slice();
      for (const current of snapshot) {
        for (const source of group) {
          for (const replacement of group) {
            if (source === replacement) continue;
            const expanded = replacePhrase(current.value, source, replacement);
            if (!expanded || seen.has(expanded)) continue;
            seen.add(expanded);
            variants.push({ value: expanded, penalty: current.penalty + 14 });
            if (variants.length >= 24) return variants;
          }
        }
      }
    }
    return variants;
  }

  const QUERY_CACHE = new Map();

  function prepareTerm(term) {
    return {
      value: term,
      variants: [term, ...getSynonyms(term)].map((value, index) => ({
        value,
        compact: value.replace(/\s+/g, ''),
        penalty: index === 0 ? 0 : 13
      }))
    };
  }

  function prepareQuery(query) {
    const originalQuery = normalizeText(query);
    if (!originalQuery) return { originalQuery, variants: [] };
    const cached = QUERY_CACHE.get(originalQuery);
    if (cached) return cached;

    const prepared = {
      originalQuery,
      variants: expandQueryPhrases(originalQuery).map(variant => {
        const queryTokens = variant.value.split(' ').filter(Boolean);
        return {
          queryNorm: variant.value,
          queryCompact: variant.value.replace(/\s+/g, ''),
          queryTokens,
          termSpecs: queryTokens.map(prepareTerm),
          penalty: variant.penalty
        };
      })
    };
    if (QUERY_CACHE.size >= 160) QUERY_CACHE.clear();
    QUERY_CACHE.set(originalQuery, prepared);
    return prepared;
  }

  function detectCategories(value) {
    const normalized = normalizeText(value);
    const compact = normalized.replace(/\s+/g, '');
    const found = [];

    for (const rule of CATEGORY_RULES) {
      if (rule.terms.some(term => {
        const termNorm = normalizeText(term);
        return normalized.includes(termNorm) || compact.includes(termNorm.replace(/\s+/g, ''));
      })) found.push(rule.id);
    }
    return found;
  }

  function createSearchIndex(products) {
    return (Array.isArray(products) ? products : []).map((product, order) => {
      const name = String(product?.nombre || '');
      const brand = String(product?.marca || '');
      const manufacturer = String(product?.fabricante || '');
      const code = String(product?.codigo || '');
      const barcode = String(product?.barras || '');
      const nameNorm = normalizeText(name);
      const brandNorm = normalizeText(brand);
      const manufacturerNorm = normalizeText(manufacturer);
      const searchableNorm = [nameNorm, brandNorm, manufacturerNorm].filter(Boolean).join(' ');

      return {
        product,
        order,
        codeNorm: normalizeText(code),
        barcodeNorm: normalizeText(barcode),
        nameNorm,
        nameCompact: nameNorm.replace(/\s+/g, ''),
        brandNorm,
        brandCompact: brandNorm.replace(/\s+/g, ''),
        manufacturerNorm,
        searchableNorm,
        searchableCompact: searchableNorm.replace(/\s+/g, ''),
        tokens: searchableNorm ? searchableNorm.split(' ').filter(Boolean) : [],
        nameTokens: nameNorm ? nameNorm.split(' ').filter(Boolean) : [],
        categories: detectCategories(name)
      };
    });
  }

  function distanceWithin(a, b, maxDistance) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      let rowMin = current[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + cost
        );
        rowMin = Math.min(rowMin, current[j]);
      }
      if (rowMin > maxDistance) return maxDistance + 1;
      previous = current;
    }
    return previous[b.length];
  }

  function bestTokenMatch(termSpec, entry) {
    let best = null;
    const variants = termSpec.variants;

    for (let i = 0; i < entry.tokens.length; i++) {
      const token = entry.tokens[i];
      for (const variant of variants) {
        const candidate = variant.value;
        let score = 0;
        let type = '';

        if (token === candidate) {
          score = 76;
          type = 'exact';
        } else if (candidate.length >= 2 && token.startsWith(candidate)) {
          score = 64 - Math.min(10, token.length - candidate.length);
          type = 'prefix';
        } else if (candidate.length >= 3 && token.includes(candidate)) {
          score = 48 - Math.min(8, token.length - candidate.length);
          type = 'contains';
        } else if (candidate.length >= 4) {
          const maxDistance = candidate.length >= 7 ? 2 : 1;
          const distance = distanceWithin(candidate, token, maxDistance);
          if (distance <= maxDistance) {
            score = distance === 1 ? 39 : 31;
            type = 'fuzzy';
          }
        }

        score = Math.max(0, score - variant.penalty);
        if (score && (!best || score > best.score)) {
          best = {
            score,
            type,
            index: i,
            token,
            synonym: variant.penalty > 0,
            matchedTerm: candidate
          };
        }
      }
    }

    if (!best) {
      for (const variant of variants) {
        const termCompact = variant.compact;
        if (termCompact.length >= 4 && entry.searchableCompact.includes(termCompact)) {
          best = {
            score: Math.max(1, 43 - variant.penalty),
            type: 'compact',
            index: -1,
            token: variant.value,
            synonym: variant.penalty > 0,
            matchedTerm: variant.value
          };
          break;
        }
      }
    }
    return best;
  }

  function scoreTextNormalized(entry, preparedVariant) {
    const { queryNorm, queryCompact, queryTokens, termSpecs } = preparedVariant;
    if (!queryTokens.length) return null;

    let score = 0;
    if (entry.nameNorm === queryNorm) score += 420;
    else if (entry.nameNorm.startsWith(queryNorm)) score += 180;
    else if (entry.nameNorm.includes(queryNorm)) score += 105;

    if (queryCompact.length >= 4) {
      if (entry.nameCompact === queryCompact) score += 240;
      else if (entry.nameCompact.startsWith(queryCompact)) score += 112;
      else if (entry.nameCompact.includes(queryCompact)) score += 72;
    }

    if (entry.brandNorm) {
      if (entry.brandNorm === queryNorm || entry.brandCompact === queryCompact) score += 170;
      else if (entry.brandNorm.startsWith(queryNorm) || entry.brandCompact.startsWith(queryCompact)) score += 92;
    }

    const matches = [];
    for (const termSpec of termSpecs) {
      const match = bestTokenMatch(termSpec, entry);
      if (!match) return null;
      matches.push(match);
      score += match.score;
    }

    const positions = matches.map(match => match.index).filter(index => index >= 0);
    if (positions.length > 1 && positions.every((position, i) => i === 0 || position >= positions[i - 1])) {
      score += 24;
    }

    const fuzzyCount = matches.filter(match => match.type === 'fuzzy').length;
    score -= fuzzyCount * 7;
    if (['obsequio', 'gratis'].includes(entry.nameTokens[0]) && !queryTokens.includes(entry.nameTokens[0])) score -= 135;

    return { score, matches, queryNorm, queryTokens };
  }

  function scorePreparedQuery(entry, preparedQuery) {
    if (!preparedQuery.variants.length) return null;
    let best = null;
    for (const variant of preparedQuery.variants) {
      const result = scoreTextNormalized(entry, variant);
      if (!result) continue;
      result.score -= variant.penalty;
      result.originalQuery = preparedQuery.originalQuery;
      result.expandedQuery = variant.queryNorm;
      if (!best || result.score > best.score) best = result;
    }
    return best;
  }

  function scoreText(entry, query) {
    return scorePreparedQuery(entry, prepareQuery(query));
  }

  function addWeight(map, key, amount) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + amount);
  }

  function topWeighted(map) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function createContext(index, options) {
    const opts = options || {};
    const sessionName = String(opts.sessionName || '');
    const sessionNorm = normalizeText(sessionName);
    const sessionCompact = sessionNorm.replace(/\s+/g, '');
    const sessionTokens = tokenize(sessionName).filter(token =>
      token.length >= 4 && !/^\d+$/.test(token) && !SESSION_STOP_WORDS.has(token)
    );

    const byCode = new Map(index.map(entry => [String(entry.product?.codigo || ''), entry]));
    const brandWeights = new Map();
    const categoryWeights = new Map();
    const countedCodes = new Set();
    const balanceCodes = new Set((opts.balanceData || []).map(item => String(item?.codigo || '')));

    const directBrands = [];
    const seenBrands = new Set();
    for (const entry of index) {
      if (!entry.brandCompact || entry.brandCompact.length < 4 || seenBrands.has(entry.brandCompact)) continue;
      seenBrands.add(entry.brandCompact);
      if (sessionCompact.includes(entry.brandCompact)) directBrands.push(entry.brandCompact);
    }

    const directCategories = detectCategories(sessionName);
    directBrands.forEach(brand => addWeight(brandWeights, brand, 120));
    directCategories.forEach(category => addWeight(categoryWeights, category, 120));

    const countItems = opts.countItems && typeof opts.countItems === 'object' ? opts.countItems : {};
    Object.values(countItems).forEach(item => {
      const code = String(item?.codigo || '');
      const entry = byCode.get(code);
      if (!entry) return;
      countedCodes.add(code);
      const weight = 2 + Math.min(4, Math.sqrt(Number(item?.qty) || 1));
      addWeight(brandWeights, entry.brandCompact, weight);
      entry.categories.forEach(category => addWeight(categoryWeights, category, weight));
    });

    const recentLog = Array.isArray(opts.actionLog) ? opts.actionLog.slice(0, 24) : [];
    recentLog.forEach((item, i) => {
      const entry = byCode.get(String(item?.codigo || ''));
      if (!entry) return;
      const weight = Math.max(1, 7 - i * 0.25);
      addWeight(brandWeights, entry.brandCompact, weight);
      entry.categories.forEach(category => addWeight(categoryWeights, category, weight));
    });

    const brandsRanked = topWeighted(brandWeights);
    const categoriesRanked = topWeighted(categoryWeights);
    const primaryBrand = brandsRanked[0]?.[0] || '';
    const primaryCategory = categoriesRanked[0]?.[0] || '';

    const brandLabelByCompact = new Map();
    index.forEach(entry => {
      if (entry.brandCompact && !brandLabelByCompact.has(entry.brandCompact)) {
        brandLabelByCompact.set(entry.brandCompact, String(entry.product?.marca || ''));
      }
    });
    const categoryLabel = CATEGORY_RULES.find(rule => rule.id === primaryCategory)?.label || '';
    const primaryBrandLabel = brandLabelByCompact.get(primaryBrand) || '';
    const labelParts = [];
    if (primaryBrandLabel && (directBrands.length || !directCategories.length)) labelParts.push(primaryBrandLabel);
    if (categoryLabel) labelParts.push(categoryLabel);

    return {
      sessionName,
      sessionNorm,
      sessionCompact,
      sessionTokens,
      directBrands: new Set(directBrands),
      directCategories: new Set(directCategories),
      brandWeights,
      categoryWeights,
      maxBrandWeight: brandsRanked[0]?.[1] || 0,
      maxCategoryWeight: categoriesRanked[0]?.[1] || 0,
      primaryBrand,
      primaryCategory,
      countedCodes,
      balanceCodes,
      label: labelParts.join(' · ')
    };
  }

  function scoreContext(entry, context) {
    if (!context) return { score: 0, reasons: [] };
    let score = 0;
    const reasons = [];

    if (context.directBrands.has(entry.brandCompact)) {
      score += 82;
      reasons.push('Sesión actual');
    } else if (context.sessionTokens.some(token =>
      entry.searchableNorm.includes(token) || entry.searchableCompact.includes(token.replace(/\s+/g, ''))
    )) {
      score += 48;
      reasons.push('Coincide con la sesión');
    }

    const brandWeight = context.brandWeights.get(entry.brandCompact) || 0;
    const brandRatio = context.maxBrandWeight ? brandWeight / context.maxBrandWeight : 0;
    if (brandRatio >= 0.18) {
      score += 55 * Math.min(1, brandRatio);
      if (!reasons.includes('Sesión actual')) reasons.push('Marca que estás contando');
    }

    const categoryWeight = Math.max(0, ...entry.categories.map(category => context.categoryWeights.get(category) || 0));
    const categoryRatio = context.maxCategoryWeight ? categoryWeight / context.maxCategoryWeight : 0;
    if (categoryRatio >= 0.18) {
      score += 62 * Math.min(1, categoryRatio);
      reasons.push('Mismo tipo de stock');
    }

    const code = String(entry.product?.codigo || '');
    if (context.countedCodes.has(code)) {
      score += 10;
      reasons.push('Ya contado');
    }
    if (context.balanceCodes.has(code)) score += 5;

    return { score: Math.min(170, score), reasons: [...new Set(reasons)].slice(0, 2) };
  }

  function rankProducts(index, query, context, limit) {
    const maxResults = Math.max(1, Number(limit) || 40);
    const ranked = [];
    const preparedQuery = prepareQuery(query);

    for (const entry of Array.isArray(index) ? index : []) {
      const text = scorePreparedQuery(entry, preparedQuery);
      if (!text) continue;
      const contextual = scoreContext(entry, context);
      ranked.push({
        product: entry.product,
        textScore: text.score,
        contextScore: contextual.score,
        // Todos los términos deben coincidir; dentro de esas coincidencias el
        // stock actual puede mover primero su marca/categoría.
        score: text.score * 4 + contextual.score * 8,
        reasons: contextual.reasons,
        matches: text.matches
      });
    }

    ranked.sort((a, b) =>
      b.score - a.score ||
      a.product.nombre.localeCompare(b.product.nombre, 'es', { sensitivity: 'base' })
    );
    return ranked.slice(0, maxResults);
  }

  function searchByCode(index, query, limit) {
    const normalized = normalizeText(query);
    if (!normalized) return [];
    return (Array.isArray(index) ? index : [])
      .filter(entry => entry.codeNorm.includes(normalized))
      .sort((a, b) => {
        const aExact = a.codeNorm === normalized ? 0 : a.codeNorm.startsWith(normalized) ? 1 : 2;
        const bExact = b.codeNorm === normalized ? 0 : b.codeNorm.startsWith(normalized) ? 1 : 2;
        return aExact - bExact || a.codeNorm.length - b.codeNorm.length || a.order - b.order;
      })
      .slice(0, Math.max(1, Number(limit) || 40))
      .map(entry => ({ product: entry.product, score: 0, textScore: 0, contextScore: 0, reasons: [] }));
  }

  return {
    normalizeText,
    compactText,
    tokenize,
    getSynonyms,
    expandQueryPhrases,
    detectCategories,
    createSearchIndex,
    createContext,
    matchesEntry: (entry, query) => Boolean(scoreText(entry, query)),
    rankProducts,
    searchByCode
  };
});
