const fs = require('fs').promises;
const path = require('path');

const PROMOTIONS_FILE = path.join(__dirname, 'promotions.json');
const PROMOTIONS_FILE_TMP = path.join(__dirname, 'promotions.json.tmp');

function toISODate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeArrayField(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const parts = value.split(/[\r?\n,]+/).map(s => s.trim()).filter(Boolean);
    return parts;
  }
  return [];
}

function normalizePromotion(p) {
  const out = Object.assign({}, p || {});
  out.id = Number(out.id || 0) || 0;
  out.title = (out.title || '').toString().trim();
  out.description = (out.description || '').toString().trim();
  if (out.code != null) out.code = String(out.code).trim();
  if (out.discount != null) out.discount = Number(out.discount);
  if (out.bonusPercentage != null) out.bonusPercentage = Number(out.bonusPercentage);
  if (out.maxBonus != null) out.maxBonus = String(out.maxBonus).trim();
  out.terms = normalizeArrayField(out.terms);
  out.howToClaim = normalizeArrayField(out.howToClaim);
  out.eligibleGames = normalizeArrayField(out.eligibleGames || out.eligibleItems);
  delete out.eligibleItems;
  out.startDate = toISODate(out.startDate);
  out.endDate = toISODate(out.endDate);
  return out;
}

// Initialize promotions file if it doesn't exist
async function initPromotions() {
  try {
    await fs.access(PROMOTIONS_FILE);
  } catch (error) {
    // File doesn't exist, create with default promotions
    const defaultPromotions = [
  {id: 1, title: "Welcome Bonus", description: "Get 10% off on your first deposit", discount: 10, code: "WELCOME10", terms: [], howToClaim: []},
  {id: 2, title: "Weekend Special", description: "25% bonus on weekend deposits", discount: 25, code: "WEEKEND25", terms: [], howToClaim: []},
  {id: 3, title: "VIP Bonus", description: "Exclusive 50% bonus for VIP members", discount: 50, code: "VIP50", terms: [], howToClaim: []}
    ];
    await savePromotions(defaultPromotions);
  }
}

// Get all promotions
async function getPromotions() {
  try {
    const data = await fs.readFile(PROMOTIONS_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    const list = jsonData.promotions || [];
    return Array.isArray(list) ? list.map(normalizePromotion) : [];
  } catch (error) {
    console.error('Error reading promotions:', error);
    try {
      const tmp = await fs.readFile(PROMOTIONS_FILE_TMP, 'utf8');
      const rec = JSON.parse(tmp);
      const list = rec.promotions || [];
      await fs.writeFile(PROMOTIONS_FILE, JSON.stringify({ promotions: list }, null, 2), 'utf8');
      return Array.isArray(list) ? list.map(normalizePromotion) : [];
    } catch (_) {
      return [];
    }
  }
}

// Save promotions to file
async function savePromotions(promotions) {
  try {
    const list = Array.isArray(promotions) ? promotions.map(normalizePromotion) : [];
    const payload = JSON.stringify({ promotions: list }, null, 2);
    await fs.writeFile(PROMOTIONS_FILE_TMP, payload, 'utf8');
    await fs.rename(PROMOTIONS_FILE_TMP, PROMOTIONS_FILE);
    return true;
  } catch (error) {
    console.error('Error saving promotions:', error);
    return false;
  }
}

// Add a new promotion
async function addPromotion(promotion) {
  const promotions = await getPromotions();
  const normalizedPromotion = normalizePromotion(promotion);
  const newId = promotions.length > 0 ? Math.max(...promotions.map(p => p.id || 0)) + 1 : 1;
  const newPromotion = { ...normalizedPromotion, id: newId };
  promotions.push(newPromotion);
  await savePromotions(promotions);
  return newPromotion;
}

// Update an existing promotion
async function updatePromotion(id, updates) {
  const promotions = await getPromotions();
  const index = promotions.findIndex(p => p.id === id);
  if (index === -1) return null;
  const updatedPromotion = normalizePromotion({ ...promotions[index], ...updates });
  promotions[index] = updatedPromotion;
  await savePromotions(promotions);
  return updatedPromotion;
}

// Delete a promotion
async function deletePromotion(id) {
  const promotions = await getPromotions();
  const index = promotions.findIndex(p => p.id === id);
  if (index === -1) return false;
  
  promotions.splice(index, 1);
  await savePromotions(promotions);
  return true;
}

// Check if user is asking for more details about promotions
function isAskingForDetails(message) {
  if (!message) return false;
  const lowerMessage = message.toLowerCase();
  const detailKeywords = ['details', 'terms', 'conditions', 'syarat', 'ketentuan', 'info', 'more', 'tambahan'];
  const claimKeywords = ['how to claim', 'how do i claim', 'cara klaim', 'cara claim', 'klaim', 'claim'];
  const promoKeywords = ['promo', 'promotion', 'bonus', 'discount', 'diskon'];
  
  // Do NOT treat claim-related keywords as 'details' here. Claim requests should be
  // handled explicitly by the chatbot flow and formatHowToClaimOnly.
  // Only treat as details when the message contains both a detail cue and a promo cue.
  return (
    detailKeywords.some(keyword => lowerMessage.includes(keyword)) &&
    promoKeywords.some(keyword => lowerMessage.includes(keyword))
  );
}

// Format detailed promotion information
function formatPromotionDetails(promotion) {
  if (!promotion) return "Promotion not found.";
  
  const now = new Date();
  let response = `🎁 ${promotion.title}\n\n`;
  
  // Basic info
  if (promotion.description) response += `📝 ${promotion.description}\n`;
  if (promotion.code) response += `🔑 Code: ${promotion.code}\n`;
  
  // Bonus details
  if (promotion.bonusPercentage) {
  response += `💰 ${promotion.bonusPercentage}% Bonus`;
    if (promotion.maxBonus) response += ` (Max: ${promotion.maxBonus})`;
  response += '\n';
  } else if (promotion.bonusAmount) {
  response += `🎰 ${promotion.bonusAmount}\n`;
  }
  
  // Validity period (robust handling)
  const hasStart = Boolean(promotion.startDate);
  const hasEnd = Boolean(promotion.endDate);
  if (hasStart || hasEnd) {
  response += `📅 Validity: `;
    if (hasStart && hasEnd) {
      response += `${new Date(promotion.startDate).toLocaleDateString()} - ${new Date(promotion.endDate).toLocaleDateString()}\n`;
    } else if (hasEnd) {
      response += `Until ${new Date(promotion.endDate).toLocaleDateString()}\n`;
    } else if (hasStart) {
      response += `From ${new Date(promotion.startDate).toLocaleDateString()}\n`;
    }
  }
  
  // Eligible games/items (fallback to either key)
  const eligArr = (promotion.eligibleGames && promotion.eligibleGames.length)
    ? promotion.eligibleGames
    : (promotion.eligibleItems && promotion.eligibleItems.length ? promotion.eligibleItems : []);
  if (eligArr.length > 0) {
  response += `🎮 Eligible Games: ${eligArr.join(', ')}\n`;
  }
  
  // Terms and conditions
  if (promotion.terms) {
  response += '\n📜 Terms & Conditions:\n';
    const terms = Array.isArray(promotion.terms) ? promotion.terms : [promotion.terms];
    terms.forEach((term, i) => {
  response += `  ${i + 1}. ${term}\n`;
    });
  }
  
  // NOTE: 'How to claim' steps are intentionally omitted here. Use formatHowToClaimOnly
  // when the user explicitly asks for claim instructions.
  
  return response;
}

// Format promotions for display
function formatPromotions(promotions, userMessage = '') {
  if (!promotions || promotions.length === 0) {
    return "No current promotions available. Check back later!";
  }
  
  const showDetails = isAskingForDetails(userMessage);
  const now = new Date();
  // Filter to only active promotions based on startDate/endDate when present
  try {
    const active = (Array.isArray(promotions) ? promotions : []).filter(p => {
      const sd = p && p.startDate ? new Date(p.startDate) : null;
      const ed = p && p.endDate ? new Date(p.endDate) : null;
      if (sd && isNaN(sd)) return false;
      if (ed && isNaN(ed)) return false;
      if (sd && now < sd) return false;
      if (ed && now > ed) return false;
      return true;
    });
    promotions = active;
    if (promotions.length === 0) return "No current promotions available. Check back later!";
  } catch (_) {}
  
  if (showDetails) {
    // Show detailed view for all promotions
    return [
      "🎉 Promotion Details 🎉\n\n",
      ...promotions.map((p, idx) => {
        const body = formatPromotionDetails(p);
        const sep = idx < promotions.length - 1 ? ('\n' + '─'.repeat(30) + '\n\n') : '';
        return body + sep;
      })
    ].join('');
  } else {
    // Show brief list view
    return [
      "🎉 Current Promotions 🎉\n\n",
      ...promotions.map((p, index) => {
        let promoText = `${index + 1}. ${p.title}\n`;
        if (p.description) promoText += `   ${p.description}\n`;
        if (p.code) promoText += `   💎 Code: ${p.code}\n`;
        if (p.bonusPercentage) promoText += `   🤑 ${p.bonusPercentage}% Bonus\n`;
        return promoText + '\n';
      }),
      "\n💡 Type 'more details' or 'terms' to see full terms and conditions for each promotion."
    ].join('');
  }
}

// Initialize the promotions file when this module is loaded
initPromotions().catch(console.error);

module.exports = {
  getPromotions,
  addPromotion,
  updatePromotion,
  deletePromotion,
  formatPromotions,
  // New helpers for strict promo-response policy
  listPromotionTitles: async function listPromotionTitles(promotions) {
    // If promotions array provided, use it; otherwise fallback to global promotions file
    let promos = promotions;
    if (!Array.isArray(promos)) {
      promos = await getPromotions();
    }
    return Array.isArray(promos) ? promos.map(p => p.title || '').filter(Boolean) : [];
  },

  findPromotionByNameOrIndex: function findPromotionByNameOrIndex(query, promotions) {
    if (!promotions || promotions.length === 0) return null;
    if (!query) return null;
    const q = String(query || '').trim().toLowerCase();
    // Try numeric index: "1" or "promo 1"
    const idxMatch = q.match(/\b(\d+)\b/);
    if (idxMatch) {
      const idx = Number(idxMatch[1]);
      // If the query explicitly references a promo index, return that promo
      if (idx >= 1 && idx <= promotions.length) return promotions[idx - 1];
      // Also allow matching by id field
      const byId = promotions.find(p => Number(p.id) === idx);
      if (byId) return byId;
    }
    // Exact title match
    for (const p of promotions) {
      if (!p || !p.title) continue;
      if (p.title.toLowerCase() === q) return p;
    }
    // Contains match (partial)
    for (const p of promotions) {
      if (!p || !p.title) continue;
      if (p.title.toLowerCase().includes(q)) return p;
    }
    // Match by promo code
    for (const p of promotions) {
      if (!p) continue;
      if (p.code && String(p.code).toLowerCase() === q) return p;
      if (p.code && String(p.code).toLowerCase().includes(q)) return p;
    }
    // Match queries like "kode WEEKEND50" or "kode: WEEKEND50"
    const codeMatch = q.match(/kode[:\s]*([a-z0-9\-\_]+)/i) || q.match(/code[:\s]*([a-z0-9\-\_]+)/i);
    if (codeMatch) {
      const code = String(codeMatch[1]).toLowerCase();
      const byCode = promotions.find(p => p.code && String(p.code).toLowerCase() === code);
      if (byCode) return byCode;
    }
    return null;
  },
  formatTermsOnly: function formatTermsOnly(promotion) {
    if (!promotion) return null;
    const lines = [];
    lines.push(promotion.title || '');
    const terms = Array.isArray(promotion.terms) ? promotion.terms : (promotion.terms ? [promotion.terms] : []);
    if (terms.length === 0) return lines.join('\n');
    for (const t of terms) {
      lines.push(`- ${String(t).trim()}`);
    }
    return lines.join('\n');
  },
  formatHowToClaimOnly: function formatHowToClaimOnly(promotion) {
    if (!promotion) return null;
    const steps = Array.isArray(promotion.howToClaim) ? promotion.howToClaim : (promotion.howToClaim ? [promotion.howToClaim] : []);
    const lines = [];
    // Localized header
    lines.push('📌 Cara klaim:');
    if (steps.length === 0) {
      // Helpful Indonesian fallback when no explicit steps were provided
      lines.push('- Masuk ke akun Anda dan ikuti instruksi promosi di halaman "Promosi". Jika perlu, hubungi CS untuk bantuan klaim.');
      return lines.join('\n');
    }
    for (const s of steps) {
      lines.push(`- ${String(s).trim()}`);
    }
    return lines.join('\n');
  }
  ,
  formatClaimInfoOnly: function formatClaimInfoOnly(promotion) {
    if (!promotion) return null;
    const lines = [];
    lines.push(`🎁 ${promotion.title || ''}`);
    if (promotion.code) lines.push(`🔑 Kode: ${promotion.code}`);
    // Eligible games/items
    const elig = Array.isArray(promotion.eligibleGames) ? promotion.eligibleGames : (Array.isArray(promotion.eligibleItems) ? promotion.eligibleItems : []);
    if (elig && elig.length) lines.push(`🎮 Berlaku untuk: ${elig.join(', ')}`);
    // Short T&C preview (first 1-2 lines)
    const termsArr = Array.isArray(promotion.terms) ? promotion.terms : (promotion.terms ? [promotion.terms] : []);
    if (termsArr && termsArr.length) {
      const preview = String(termsArr[0]).trim();
      lines.push(`📜 Syarat utama: ${preview.length > 120 ? preview.slice(0, 117) + '...' : preview}`);
    }
    // Validity
    if (promotion.startDate || promotion.endDate) {
      const sd = promotion.startDate ? new Date(promotion.startDate).toLocaleDateString() : null;
      const ed = promotion.endDate ? new Date(promotion.endDate).toLocaleDateString() : null;
      if (sd && ed) lines.push(`📅 Berlaku: ${sd} - ${ed}`);
      else if (ed) lines.push(`📅 Berlaku sampai: ${ed}`);
      else if (sd) lines.push(`📅 Berlaku mulai: ${sd}`);
    }
    lines.push('\nUntuk langkah klaim, ketik "cara klaim" jika Anda ingin petunjuk langkah demi langkah.');
    return lines.join('\n');
  }
};
