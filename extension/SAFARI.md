# Porter l'extension sur Safari (Mac + iPhone)

Le code de `extension/` est **déjà compatible Safari** : la passerelle `wapi`
(`browser` ou `chrome` selon le navigateur) est en place dans `content.js`, `popup.js`
et `background.js`, et aucune syntaxe non supportée n'est utilisée.

Il ne reste que l'**empaquetage**, qui exige obligatoirement un Mac — Apple ne permet pas
de construire ni de signer une extension Safari depuis Windows ou Linux.

## Ce qu'il faut

- Un **Mac** (ou un service de build cloud type MacStadium / Codemagic)
- **Xcode** (gratuit, sur le Mac App Store)
- Un **compte Apple Developer** à **99 $/an** — obligatoire pour publier sur iPhone
  (pour tester sur ton propre appareil uniquement, un compte gratuit suffit, avec
  une signature à renouveler tous les 7 jours)

## Étapes

```bash
# 1. Convertir l'extension existante en projet Xcode
xcrun safari-web-extension-converter /chemin/vers/worthit/extension \
  --project-location ~/WorthitSafari \
  --app-name "Worthit" \
  --bundle-identifier app.worthit.extension

# 2. Ouvrir le projet généré
open ~/WorthitSafari/Worthit/Worthit.xcodeproj
```

Dans Xcode :
1. Sélectionner la cible **iOS** (le convertisseur crée macOS + iOS).
2. Onglet *Signing & Capabilities* → choisir ton équipe Apple.
3. Lancer sur le simulateur ou un iPhone connecté.
4. Sur l'iPhone : **Réglages → Apps → Safari → Extensions → Worthit** → activer,
   puis autoriser l'accès aux sites (« Toujours autoriser » pour que le blocage marche partout).

## Ce que ça couvre — et ce que ça ne couvre pas

| | Couvert |
|---|---|
| Achats faits **dans Safari** sur iPhone/Mac | ✅ oui (pause, minuteur, mots-clés, mode strict, Worthy) |
| Achats faits dans les **applis natives** (Amazon, Shein, Vinted…) | ❌ non |

iOS interdit à toute app de surveiller ce qui se passe dans une autre app. C'est une
limite de la plateforme, pas du code : **aucune app iPhone ne peut faire ça**, quel que
soit le budget. Le shopping web dans Safari est le maximum atteignable.

## Notes techniques

- **MV3** : Safari 16.4+ gère `background.service_worker`. Pour viser Safari 15,
  remplacer par `"background": { "scripts": ["background.js"], "persistent": false }`
  dans une copie du manifest dédiée à Safari.
- **`host_permissions`** : supporté, mais Safari demande à l'utilisateur d'accorder
  l'accès site par site — d'où la recommandation « Toujours autoriser ».
- **`storage.sync`** : supporté ; la synchronisation passe par iCloud au lieu du compte Google.
