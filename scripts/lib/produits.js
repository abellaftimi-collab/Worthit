/*
 * Illustrations de produits pour les visuels de présentation (images et vidéo).
 *
 * Pourquoi dessinées et non photographiées : une vraie photo de produit appartient à
 * quelqu'un, et une marque reconnaissable dans un support promotionnel expose le projet
 * sans rien apporter à la démonstration. Des silhouettes suffisent à faire lire
 * « page marchande » en une fraction de seconde.
 *
 * Volontairement quatre objets seulement, choisis pour rester lisibles à petite taille.
 * Une basket de profil et un sac à dos ont été tentés puis écartés : à ce niveau de
 * simplification ils se lisaient comme un chausson et comme une télécommande.
 */

/* Chaque entrée renvoie un SVG dimensionné, à centrer dans la zone image d'une fiche.
 * `teinte` permet d'éclaircir ou d'assombrir selon le fond. */
const PRODUITS = [
  /* Casque audio — c'est la fiche mise en avant : 149 € y est crédible. */
  (t, o = 0.85) => `<svg width="${t}" height="${t}" viewBox="0 0 100 100">
    <g fill="none" stroke="rgba(255,255,255,${o})" stroke-width="4" stroke-linecap="round">
      <path d="M18 62 V50 A32 32 0 0 1 82 50 V62"/>
      <rect x="8" y="58" width="20" height="30" rx="9" fill="rgba(255,255,255,${o * 0.35})"/>
      <rect x="72" y="58" width="20" height="30" rx="9" fill="rgba(255,255,255,${o * 0.35})"/>
    </g></svg>`,

  /* Appareil photo */
  (t, o = 0.85) => `<svg width="${t}" height="${t}" viewBox="0 0 100 100">
    <g stroke="rgba(255,255,255,${o})" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path fill="rgba(255,255,255,${o * 0.3})" d="M12 34 H30 L36 24 H64 L70 34 H88 C91 34 93 36 93 39 V76 C93 79 91 81 88 81 H12 C9 81 7 79 7 76 V39 C7 36 9 34 12 34 Z"/>
      <circle cx="50" cy="57" r="17" fill="rgba(255,255,255,${o * 0.4})"/>
      <circle cx="50" cy="57" r="7" fill="none"/>
    </g></svg>`,

  /* Montre */
  (t, o = 0.85) => `<svg width="${t}" height="${t}" viewBox="0 0 100 100">
    <g fill="none" stroke="rgba(255,255,255,${o})" stroke-width="4" stroke-linecap="round">
      <path d="M38 22 L36 8 H64 L62 22 M38 78 L36 92 H64 L62 78"/>
      <circle cx="50" cy="50" r="26" fill="rgba(255,255,255,${o * 0.35})"/>
      <path d="M50 38 V50 L59 56"/>
    </g></svg>`,

  /* Sweat / t-shirt */
  (t, o = 0.85) => `<svg width="${t}" height="${t}" viewBox="0 0 100 100">
    <g fill="none" stroke="rgba(255,255,255,${o})" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path fill="rgba(255,255,255,${o * 0.32})" d="M36 20 L22 27 L14 50 L26 55 V84 H74 V55 L86 50 L78 27 L64 20 Z"/>
      <path d="M36 20 C40 32 60 32 64 20"/>
    </g></svg>`,
];

module.exports = { PRODUITS };
