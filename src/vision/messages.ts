// User-facing messages: plain French, always with a concrete tip.
import type { Msg } from './types.ts';

export const M = {
  noMarkers: (): Msg => ({
    code: 'NO_MARKERS',
    text: 'Ni feuille ni tapis détecté.',
    tip: 'Posez une feuille blanche (Lettre ou A4) sur une table plus foncée et cadrez ses 4 coins, ou cadrez le tapis imprimé avec ses carrés noirs.',
  }),
  sheetBorder: (): Msg => ({
    code: 'SHEET_BORDER',
    text: 'Le verre touche le bord de la feuille.',
    tip: 'Éloignez le verre d’au moins 1 cm des bords de la feuille.',
  }),
  sheetInfo: (label: string): Msg => ({
    code: 'SHEET',
    text: `Référence : ${label} (sans tapis imprimé).`,
    tip: 'Le verre le plus à gauche est le verre droit (OD). Pour plus de précision, utilisez la boîte lumineuse avec le tapis imprimé.',
  }),
  severalLenses: (eye: string): Msg => ({
    code: 'SEVERAL',
    text: `Plusieurs verres sur la photo : le plus grand est enregistré comme verre ${eye}.`,
    tip: 'Pour une photo par verre, ne laissez qu’un seul verre sur la feuille.',
  }),
  fewMarkers: (n: number): Msg => ({
    code: 'FEW_MARKERS',
    text: `Seulement ${n} repère${n > 1 ? 's' : ''} visible${n > 1 ? 's' : ''} (il en faut 3).`,
    tip: 'Reculez un peu, ou cadrez la moitié de la feuille où se trouve le verre avec ses repères.',
  }),
  blurry: (mm: number): Msg => ({
    code: 'BLUR',
    text: `Photo floue (bords étalés sur ${mm.toFixed(1)} mm).`,
    tip: 'Tenez le téléphone immobile à ~25 cm, touchez l’écran pour faire la mise au point, évitez la pénombre.',
  }),
  slightlyBlurry: (mm: number): Msg => ({
    code: 'BLUR_WARN',
    text: `Netteté moyenne (${mm.toFixed(1)} mm).`,
    tip: 'Pour plus de précision, reprenez la photo bien immobile.',
  }),
  notFlat: (mm: number): Msg => ({
    code: 'NOT_FLAT',
    text: `La feuille ne semble pas plane (écart ${mm.toFixed(2)} mm entre repères).`,
    tip: 'Posez le tapis bien à plat : pas de pli, pas de bord relevé.',
  }),
  tilted: (deg: number): Msg => ({
    code: 'TILT',
    text: `Photo très inclinée (${Math.round(deg)}°).`,
    tip: 'Tenez le téléphone plus à plat, parallèle à la feuille.',
  }),
  noZone: (): Msg => ({
    code: 'NO_ZONE',
    text: 'Aucune zone de verre n’est entièrement dans la photo.',
    tip: 'Cadrez au moins une zone (OD ou OS) en entier, avec les repères autour.',
  }),
  noLens: (): Msg => ({
    code: 'NO_LENS',
    text: 'Aucun verre détecté sur le tapis.',
    tip: 'Posez le verre au centre d’une zone, face bombée vers le haut. Évitez les reflets directs d’une lampe.',
  }),
  lensBorder: (): Msg => ({
    code: 'LENS_BORDER',
    text: 'Le verre touche le bord de la zone.',
    tip: 'Recentrez le verre dans la zone imprimée (entre les coins gris).',
  }),
  lensSize: (a: number, b: number): Msg => ({
    code: 'LENS_SIZE',
    text: `Taille inhabituelle pour un verre (${a.toFixed(0)} × ${b.toFixed(0)} mm).`,
    tip: 'Vérifiez qu’un seul verre est dans la zone et que rien ne le touche.',
  }),
  lowConfidence: (): Msg => ({
    code: 'LOW_CONF',
    text: 'Contour incertain (reflets ou bord peu visible).',
    tip: 'Essayez la boîte lumineuse : feuille posée sur l’écran blanc d’un portable, ou près d’une fenêtre.',
  }),
  irregular: (): Msg => ({
    code: 'IRREGULAR',
    text: 'Forme irrégulière détectée.',
    tip: 'Un reflet ou un objet touche peut-être le verre. Vérifiez l’image de contrôle.',
  }),
  classicFallback: (): Msg => ({
    code: 'CLASSIC',
    text: 'Modèle IA indisponible : segmentation classique utilisée.',
  }),
  failed: (e: unknown): Msg => ({
    code: 'FAILED',
    text: 'Le traitement de la photo a échoué.',
    tip: `Réessayez avec une autre photo. (${String(e).slice(0, 120)})`,
  }),
};
