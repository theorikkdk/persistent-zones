# Persistent Zones — règles de développement

## Projet

- Module Foundry VTT : Persistent Zones ; système principal : D&D5e.
- Règles de référence : D&D 2024 / SRD 5.2.1.
- Le module reste générique : les sorts sont, autant que possible, des configurations de primitives PZ.

## Langues

Tout contenu visible est disponible en français et en anglais : labels, presets, options UI, descriptions, notifications, messages et outils Debug/Test. Le testeur principal utilise Foundry en français.

- Toute clé visible est ajoutée à `lang/fr.json` et `lang/en.json`.
- Ne jamais ajouter uniquement une version anglaise.
- Les identifiants techniques internes restent stables et peuvent être en anglais.

## Architecture et Activities

Privilégier, dans cet ordre : une primitive existante, son extension générique, puis une nouvelle primitive générique si nécessaire. Éviter les hacks propres à un sort ; les presets SRD décrivent principalement des données.

Persistent Zones est basé sur les Activities D&D5e. Un Item peut contenir plusieurs Activities PZ pour des variantes réelles d’un même sort ; ne pas créer plusieurs Items dans ce cas.

## Tests Foundry et workflow

L’utilisateur ne doit jamais fabriquer manuellement une Activity complexe pour un test. Si une configuration particulière est nécessaire, fournir un preset Debug/Test ou un helper Debug prêt à l’emploi, avec les libellés FR/EN pertinents.

Pendant un chantier :

- ne pas commit automatiquement ;
- conserver les changements non commités jusqu’à validation Foundry ;
- utiliser des diagnostics temporaires seulement lorsqu’ils sont nécessaires au runtime réel.

Après validation Foundry : retirer les diagnostics temporaires non permanents, relancer les validations et ne committer qu’après demande explicite. Les tests automatisés ne remplacent pas une validation Foundry lorsque le comportement dépend du runtime Foundry.

Avant de proposer une validation Foundry ou un commit, exécuter les contrôles adaptés : suite complète, tests ciblés, `node --check` des JS/MJS concernés, validation des JSON concernés et `git diff --check`. Rapporter clairement les résultats.

## Régressions

Toute primitive générique préserve le comportement historique quand sa nouvelle configuration est absente. Ajouter des tests de non-régression lorsque nécessaire.

## D&D 2024 — zones, Total Cover et origine

Une AoE avec un véritable point d’origine est bloquée par Total Cover, sauf texte spécifique contraire. M11D représente actuellement cette restriction géométrique en 2D.

Le proxy Foundry principal de Total Cover est `move`, pas `sight` : une paroi transparente peut arrêter physiquement une AoE, et un rideau peut bloquer la vision sans fournir une couverture totale. Ne pas changer cette doctrine sans audit explicite.

Origines par défaut :

- circle/ring : centre ;
- rectangle/square : centre ;
- cone : pointe ;
- line/ray : départ ;
- emanation : source ;
- wall : cas spécial à traiter séparément.

Un preset peut ultérieurement déroger à cette convention si le RAW l’exige.

## Limites géométriques

PZ est principalement un modèle de combat 2D. Ne pas simuler artificiellement une volumétrie 3D sans décision explicite. Pour un sort qui exige hauteur, cube, sphère 3D, cylindre vertical ou support physique 3D, signaler la limite avant une approximation importante.

## Terrain, fréquence et scaling

`terrain.multiplier` est un coût de déplacement, pas une modification générique de la caractéristique Speed. Toute approximation produit doit être explicitement décidée.

Un `frequencyGroup` explicite partage une limite entre triggers tout en restant scopé par cast/zone/source, cible, combat, round et turn. Pour un événement temporel tel que `turnEnd`, utiliser le contexte du tour concerné, pas nécessairement l’état live du Combat après transition.

Utiliser le resolver générique de scaling PZ pour dégâts, soins et PV temporaires. Le mode normal utilise le niveau de l’Item comme référence. Ne pas créer un second moteur de scaling, ni l’étendre implicitement à géométrie, rayon, durée, DD, terrain, murs, lumière ou conditions.

## Presets SRD

Les presets officiels ont des IDs stables : ne pas modifier un ID publié sans migration nécessaire. Séparer les presets de production/SRD des presets et helpers Debug/Test.

### Sélection des sorts Persistent Zones

Persistent Zones n’est pas un moteur générique pour toutes les AoE D&D5e. Un sort est un bon candidat lorsqu’une zone reste présente après sa résolution initiale et continue d’automatiser la scène ou les créatures : entrée, sortie, mouvement, tours, dégâts ou JDS répétés, conditions, terrain, obscurcissement, murs, lumière, aura ou émanation.

Une AoE ponctuelle (dégâts, soin, JDS ou effet unique, simple gabarit de lancement) doit normalement rester une Activity D&D5e classique. Les sorts `Instantaneous` sont hors priorité PZ par défaut, même s’ils modifient narrativement le monde ; une exception exige de justifier une automatisation de combat persistante réellement utile. La partie narrative de Plant Growth lancée en 8 heures n’est pas une Persistent Zone.

Avant tout nouveau preset, vérifier : « Après le lancement initial, cette zone doit-elle encore automatiser quelque chose pendant plusieurs instants ou tours ? » Si non, utiliser une Activity classique ou ne rien automatiser avec PZ.

## Rapports Codex

Terminer par un rapport court et actionnable : modifications, fichiers concernés, tests, test Foundry à effectuer, état du worktree et confirmation explicite d’un commit ou de son absence.
