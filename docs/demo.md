# Démo OptiFrame : 5 minutes + 2 minutes de questions

## Matériel (à vérifier avant de passer)
- 2 tapis A4 imprimés à 100 % : contrôler la règle de 100 mm au réglet, garder un tapis de rechange.
- Un portable ou une tablette avec l’app ouverte en mode **Boîte lumineuse** (Aide → Boîte lumineuse), luminosité au maximum.
- Un téléphone chargé avec l’app déjà ouverte une fois : le moteur est en cache, ce qui permet de fonctionner sans réseau.
- Le QR code affiché (README ou Aide → Partager), une monture imprimée si possible, la vidéo de secours sur le téléphone.

## Déroulé

| Temps | Action | Ce qu’on dit |
|---|---|---|
| 0:00 | QR code à l’écran, le jury scanne | « Aucune installation, aucun compte. Tout tourne dans le navigateur, hors ligne : pensé pour les zones sans opticien. » |
| 0:30 | Poser le tapis sur la boîte lumineuse, les 2 verres du jury face bombée vers le haut | « Dispositif en 30 secondes : une feuille A4, 8 repères ArUco, et l’écran d’un portable comme boîte lumineuse. » |
| 1:00 | **Photographier** : le guidage passe au vert (« Prêt · 8 repères ») | « Une seule photo pour les deux verres. » |
| 1:20 | Résultat : image de contrôle, A, B, périmètre | Lire A et B à voix haute, le jury compare avec son pied à coulisse. |
| 1:50 | **Pas à pas** : repères → vue redressée → carte de l’IA → contour affiné | « Affinage sub-pixel des repères, homographie à 0,01 mm de reprojection. L’IA trouve le verre malgré les reflets, puis on recale le contour sur la photo d’origine en pleine résolution. » |
| 2:40 | **Monture** : aperçu 3D, régler le pont (18 mm), **Télécharger monture.stl** | « Deux verres de formes différentes, deux cercles différents. Rainure en V à 45° qui s’imprime sans supports, jeu de 0,2 mm, tenons avec charnière. » |
| 3:30 | **Valider** : superposition verre/rainure (0,20 mm mesuré sur le maillage), reprendre une photo pour montrer ΔA/ΔB | « On contrôle la cohérence sur le maillage réel et entre deux prises. » |
| 4:10 | Données et IA (README) | « Aucun jeu de données n’existait : générateur synthétique dans le domaine redressé, 224 000 images. Sur photos simulées, l’erreur passe de 1,6 mm à environ 0,2 mm avec l’IA. Et la *capture appariée* permet d’annoter automatiquement de vraies photos. » |
| 4:40 | Limites (honnêtement) | « Modèle entraîné sur du synthétique, validé sur nos verres au pied à coulisse ; verres démontés uniquement ; les branches ne sont pas générées. » |

## Questions probables
- **Pourquoi pas Segment Anything ?** ~40 Mo et plusieurs secondes par image sur téléphone, sans mode hors ligne. Notre U-Net pèse 2 Mo et passe en environ 0,3 s.
- **D’où vient la précision ?** Repères affinés sur leurs bords, homographie sur 32 coins, contour recalé sur la photo native, correction de parallaxe, échelle d’impression contrôlée.
- **Et si l’imprimante réduit la page ?** On mesure la règle de 100 mm et on saisit la valeur : toutes les mesures sont corrigées, même les anciennes.
- **Le verre se clipse-t-il ?** Lèvre avant de 0,8 mm, lèvre arrière de 0,4 mm, jeu de 0,2 mm, tout est réglable. En PLA, on peut chauffer légèrement ; le PETG est plus souple.

## Plan B
- Pas de réseau : l’app est en cache (l’ouvrir une fois avant).
- Caméra refusée : bouton **Importer** (photo prise avec l’appareil photo natif).
- Rien ne marche : **Essayer avec une photo d’exemple**, puis la vidéo de secours.
