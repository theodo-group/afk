# Handoff : refaire le schéma et la présentation AFK pour la STIME

> À coller comme premier message dans une session Claude Code **locale**, ouverte sur une machine qui a accès au repo STIME à faire tourner dans AFK (et idéalement au repo `theodo-group/afk`).

## Objectif

Tu prends la suite d'une session cloud qui a préparé le **point Sécurité avec la STIME** pour déployer **AFK** sur GCP. AFK (https://github.com/theodo-group/afk, open source) fait tourner des agents Claude Code dans des VMs éphémères.

Refais les deux livrables avec un meilleur contexte : tu as en local le **repo STIME que l'on veut faire tourner dans AFK**, ce que la session cloud n'avait pas. Elle a dû laisser beaucoup de trous `[…]` et d'hypothèses. Remplace-les par des faits tirés du repo, et liste clairement ce qui reste à obtenir de la STIME.

Livrables :
1. **Schéma d'architecture cible STIME**, au format Épure (paire `.epr.d2` + `.epr.layout.json`, plus un export PNG).
2. **Présentation** pour la Sécurité STIME, en français (~15 slides).

Tout est en français. Pas de PR : commit et push seulement sur la branche indiquée ci-dessous.

## Contexte métier (le compte rendu dont on part)

> Sujet initié avec Malek Chouchene et Oussama Hasni : utiliser afk/terraform/gcp pour déployer des VMs dans l'infra GCP sur lesquelles faire tourner des agents Claude.
> Next steps : Hugo partage le code GCP à Oussama (open source). Hugo prépare une petite présentation de l'outil AFK, un schéma d'archi de ce qui va être fait sur GCP, les besoins en VM, la liste des IP sources, la liste des IP destinations et la liste des ports concernés. Christophe organise un point avec le responsable Sécurité, la semaine prochaine si possible.

## Exigences de Hugo (décisions prises, à respecter)

- **SSH uniquement depuis le VPN STIME.**
- **Artifact Registry de la STIME** pour les images (pas le repo `afk` créé par défaut).
- **GitLab STIME** comme source du code (clone et push de branches).
- **Environnement d'homologation** joignable par l'agent si besoin.
- **Claude avec les licences existantes, PAS Vertex AI** (Vertex AI serait facturé au token).
  - Chaque développeur lance `claude setup-token` (jeton d'un an, valable pour les licences Pro, Max, Team et Enterprise). Le jeton est stocké comme secret afk et injecté en `CLAUDE_CODE_OAUTH_TOKEN=secret:claude-oauth-<dev>` dans le `.afk.env` du développeur.
  - Ne **jamais** définir `ANTHROPIC_API_KEY` en même temps : elle passe avant le jeton de licence et serait facturée au token.
  - Doc : https://code.claude.com/docs/en/authentication

## Ce qu'afk GCP fait aujourd'hui (vérifié dans le code)

Lis toi-même, dans le repo afk : `terraform/gcp/*.tf`, `docs/backends/gcp.md`, `cli/src/backends/gcp/` (en particulier `GcpStartupScript.ts`, `GcpGoldenImage.ts`, `GcpGoldenPlan.ts`, `GcpNetworkPlacement.ts`, `GcpImageRegistry.ts`), `cli/src/adapters/gcp/Gce.ts`, `entrypoint/entrypoint.sh` et `docs/recipes/claude-code.dockerfile`.

Faits établis :
- **Un Run = une VM Compute Engine.**
  - Création : depuis la Golden Image (Debian 12 + Docker CE + gcloud), `--no-address` (pas d'IP publique), Spot par défaut, `max_run_duration`, scope `cloud-platform`, tag réseau `afk-run`.
  - Démarrage : un startup-script pull l'image, lit les secrets `afk-*` via `gcloud secrets versions access` et écrit un fichier d'env en chmod 600. L'entrypoint clone ensuite le repo (GitHub avec `GITHUB_TOKEN`, GitLab avec `GITLAB_TOKEN` et l'utilisateur `oauth2`).
  - Fin : upload des Session Artifacts sur GCS, puis la VM se supprime elle-même, ou s'arrête si `--retain`.
- **Défauts :** `e2-standard-4` ; types autorisés : e2-medium, e2-standard-2/4, n2-standard-2/4/8/16 ; timeout 4 h, plafond 8 h ; région `us-central1`. Le **disque n'est pas spécifié** : on a la taille de l'image, soit 10 Go, probablement trop peu. La VM de build de la Golden Image est une `e2-standard-2` On-Demand, 1 h max.
- **Réseau Terraform :**
  - VPC `afk-vpc`, subnet `10.40.0.0/20` avec Private Google Access ;
  - firewall : entrée tcp/22 seulement depuis `35.235.240.0/20` (IAP), deny explicite pour tout le reste en entrée ;
  - Cloud NAT en `AUTO_ONLY` (IP qui changent) ; aucun filtrage en sortie.
- **IAM :**
  - SA `afk-vm` : lecture Artifact Registry, accès aux secrets `afk-*` (condition sur le préfixe), logWriter, objectCreator sur le bucket des artefacts, rôle custom delete/stop.
  - Rôle `afk-developer` : instances create/delete/start/stop, actAs `afk-vm` uniquement, IAP tunnel, OS Login.
  - SA `afk-sweeper` : Cloud Function gen2 + Cloud Scheduler toutes les 5 min ; list/get/delete des VMs, datastore.user.
  - Firestore (`afk-runs`) n'est écrit que par la CLI et le sweeper. La VM n'a pas de droit Firestore, même si la doc gcp.md dit le contraire.
- **Limites IAM documentées dans `iam.tf` :** IAM ne lit pas les labels. « Seulement mes Runs », « image golden uniquement » et « VMs gérées par afk uniquement » ne sont donc vérifiés que par la CLI. Les SA `afk-vm` et `afk-sweeper` peuvent supprimer n'importe quelle VM du projet.

## Ce qu'afk ne sait PAS encore faire pour la STIME

Présente-le comme « adaptations nécessaires », sans l'implémenter ici :
1. **Registre codé en dur :** `GCP_ARTIFACT_REPO` dans le projet afk, et la CLI crée le repo s'il manque. Il faut un registre configurable (projet, région, repo), avec un droit de lecture pour `afk-vm`.
2. **Subnet codé en dur :** `afk-subnet` dans le projet afk (`GcpNetworkPlacement.ts`). Il faut pouvoir utiliser un subnet existant (Shared VPC STIME), avec un module réseau Terraform optionnel.
3. **SSH depuis le VPN :** avec IAP, les paquets arrivent toujours depuis `35.235.240.0/20`, donc on ne peut pas filtrer le VPN au firewall. Solution retenue : un niveau d'accès Access Context Manager sur les IP de sortie du VPN, en condition IAM sur `roles/iap.tunnelResourceAccessor`. Il est défini au niveau de l'organisation GCP STIME ; chaque connexion est tracée dans les logs d'audit. Alternative si un VPN ou un Interconnect vers GCP existe déjà : SSH direct sur l'IP privée depuis les plages du VPN. Il faudrait alors une option dans `afk attach`, qui force aujourd'hui `--tunnel-through-iap`.
4. **Sorties :** deny par défaut, plus une allowlist de CIDR, de ports et de FQDN. NAT avec IP statiques (`MANUAL_ONLY`).
5. **Secrets partagés :** chaque VM peut lire **tous** les secrets `afk-*`, donc aussi les jetons Claude des autres développeurs. Il faut que chaque Run ne lise que les secrets de son développeur.
6. Déjà supporté : GitLab (`GITLAB_TOKEN`) et les licences Claude (`CLAUDE_CODE_OAUTH_TOKEN`). Une CA interne STIME s'ajoute dans l'`afk.Dockerfile` si besoin.

## Flux réseau déjà identifiés (à compléter avec le repo STIME)

**Sources :**
- VPN STIME [IP de sortie ?] → `*.googleapis.com:443`, `[région]-docker.pkg.dev:443` (push vers le registre STIME), `tunnel.cloudproxy.app:443` (IAP) ;
- `35.235.240.0/20` → VMs :22 ;
- Cloud Scheduler → Function (HTTPS, OIDC).

**Destinations via Google (Private Google Access) :** `[région]-docker.pkg.dev` (registre STIME), `secretmanager`, `logging`, `storage`, `compute`, `oauth2.googleapis.com`, et `169.254.169.254` (ports 80 et 53).

**Destinations via le réseau privé STIME :** GitLab STIME (443, ou 22 si clone SSH), homologation [CIDR et ports ?], DNS interne [?].

**Destinations Internet via NAT (allowlist) :**
- `api.anthropic.com` et `platform.claude.com` (liste officielle : https://code.claude.com/docs/en/network-config). `claude.ai` et `claude.com` ne servent qu'à générer le jeton, sur le poste du développeur.
- La télémétrie part vers Datadog (`http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com`) : à couper avec `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Une version précédente citait statsig et sentry, c'était faux.
- Dépendances (npm, PyPI…) : de préférence via des dépôts distants dans l'Artifact Registry STIME.
- Build de la Golden Image : `deb.debian.org`, `download.docker.com`, `packages.cloud.google.com`, Docker Hub (ponctuel).

## Ce que tu dois faire en plus grâce au repo STIME local

Demande à Hugo le chemin du clone s'il n'est pas évident. Travaille en **lecture seule** sur ce repo. Ne recopie **aucune valeur de secret** : seulement les noms de variables et les fichiers.

Tires-en :
- **Stack et gestionnaires de paquets**, avec les registres configurés (`.npmrc`, `pip.conf`, `settings.xml`… : public ou miroir STIME ?).
- **Sidecars** nécessaires aux tests (`docker-compose*`, services de `.gitlab-ci.yml`) : ils vont dans `cachedImages` et dans `afk.compose.yml`.
- **URL exacte du GitLab**, HTTPS ou SSH, et une éventuelle **CA interne**.
- **Hôtes, ports et protocoles de l'homologation** et des autres services internes appelés.
- **Variables et secrets** nécessaires (noms seulement).
- **Dimensionnement VM réaliste** : CPU, RAM, disque.

Mets à jour en conséquence les tableaux de flux, la slide des besoins en VM et la liste des questions ouvertes. Si c'est utile, ajoute en annexe des brouillons `afk.Dockerfile`, `afk.compose.yml`, un extrait `afk.config.json` et un `.afk.env.example`.

## Livrables existants à reprendre (pas à recopier aveuglément)

- **Repo afk**, branche `claude/loving-archimedes-x3agml`, dossier `docs/diagrams/` :
  - `gcp-architecture.*` : afk GCP tel qu'il est aujourd'hui ;
  - `gcp-architecture-stime.*` : la cible STIME. C'est la version à améliorer.

  Travaille et pousse sur cette branche, sans PR.
- **Outil Épure :** `npx -y @theodo-group/epure <fichier>.epr.d2` (éditeur live), `epure icons <requête>`, `epure validate`, `epure fmt`, `epure export <f> -o x.png`. Le skill est dans le repo `theodo-group/epure`, fichier `skills/epure-diagram/SKILL.md` ; `npx @theodo-group/epure skill install` l'installe. Icônes utiles : `gcp/compute/compute-engine`, `gcp/security/iap`, `gcp/security/secret-manager`, `gcp/devtools/container-registry`, `gcp/operations/logging`, `gcp/storage/storage`, `gcp/database/firestore`, `gcp/network/nat`, `gcp/network/firewall-rules`, `gcp/network/dedicated-interconnect`, `gcp/compute/functions`, `gcp/devtools/scheduler`, `onprem/vcs/gitlab`, `lobe/ai/anthropic`, `lobe/ai/claudecode`, `fontawesome/brands/docker`.
- **Présentation actuelle** (15 slides, Artifact Slides privé de Hugo) : https://claude.ai/artifact/15dmVFBSfkf6YSdxzVT3Nk. Tu peux la mettre à jour si tu as l'outil Artifact, sinon produis un .pptx.
  - Plan : couverture · AFK en bref · cycle de vie d'un Run · schéma · inventaire Terraform · besoins VM · SSH depuis le VPN (trois niveaux : réseau, identité, VPN) · IP sources · destinations Google · destinations STIME et Anthropic · IAM · risques · adaptations d'AFK · mesures proposées · questions pour la STIME.
  - Style : IBM Plex Sans et JetBrains Mono ; fond `#F6F5F1` et `#172033`, accent `#B24A28`.
  - Défauts connus :
    - les slides 5 (inventaire) et 11 (IAM) décrivent encore afk par défaut (son propre VPC et son propre registre), pas la cible STIME ;
    - les chiffres de volume (Runs en parallèle, nombre de développeurs, taille du pilote) sont en `[__]`, tout comme la date du point ;
    - le rendu n'a jamais été vérifié visuellement.

## Risques à présenter honnêtement

- l'agent agit seul sur l'homologation (il faut des comptes de test dédiés, avec des droits minimum) ;
- les secrets sont visibles par l'agent, et toute VM lit tous les secrets `afk-*` ;
- le subnet AFK devient une porte vers le réseau interne (flux à limiter à GitLab et à l'homologation) ;
- contrôles côté CLI seulement ;
- droit de suppression large (d'où un projet dédié) ;
- le code est envoyé à l'API Anthropic sous contrat de licence ;
- région US par défaut (d'où une région EU) ;
- scope `cloud-platform` sur la VM.

## Définition de « fini »

- Le schéma STIME et son PNG sont mis à jour, passent `epure validate` et `epure fmt`, et sont poussés sur la branche.
- La présentation est complète : plus aucun trou que le repo STIME permettait de combler, et une dernière slide liste précisément ce que la STIME doit fournir.
- Tu as vérifié visuellement le rendu du schéma et des slides.
- Un court récapitulatif pour Hugo indique ce qui a changé par rapport à la version cloud et ce qui reste ouvert.
