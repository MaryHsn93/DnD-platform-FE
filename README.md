# D&D Portal — Frontend

Frontend web a tema dark per una piattaforma Dungeons & Dragons, con gestione personaggi, campagne, compendio, strumenti per DM e chat in tempo reale.

## Funzionalità

- **Autenticazione** — Login e registrazione con landing page animata
- **Dashboard** — Hub centrale per giocatori e DM
- **Personaggi** — Creazione, modifica e gestione dei personaggi con import/export scheda PDF
- **Campagne** — Creazione e gestione campagne
- **Compendio** — Riferimento consultabile per classi, specie, incantesimi, mostri, equipaggiamento, talenti e altro (18 categorie)
- **Supporto DM** — Strumenti di supporto per il Dungeon Master
- **Documenti** — Visualizzatore e gestore documenti
- **Chat** — Messaggistica in tempo reale stile WhatsApp (WebSocket + fallback REST)

## Tecnologie

- HTML / CSS / JavaScript vanilla (nessun build step, nessun framework)
- Three.js per effetti 3D nella landing page
- Google Fonts (Cinzel, Inter)
- Backend a microservizi tramite REST API + WebSocket

## Struttura del Progetto

```
├── index.html              # Pagina di login / registrazione
├── dashboard.html          # Dashboard principale
├── characters.html         # Gestione personaggi
├── campaigns.html          # Gestione campagne
├── compendium.html         # Hub del compendio
├── compendium-*.html       # 18 pagine per categoria del compendio
├── dm-support.html         # Strumenti DM
├── documents.html          # Pagina documenti
├── js/
│   ├── env.js              # Configurazione host/porte backend
│   ├── api.js              # Client API
│   ├── auth.js             # Logica di autenticazione
│   ├── utils.js            # Utilità condivise
│   ├── chat.js             # Modulo chat (TavernChat)
│   └── pdf-viewer.js       # Logica visualizzatore PDF
├── css/
│   ├── chat.css            # Stili chat
│   └── pdf-viewer.css      # Stili visualizzatore PDF
└── assets/                 # Immagini, texture, template PDF
```

## Installazione

1. Clona il repository:
   ```bash
   git clone <repository-url>
   ```

2. Configura la connessione al backend in `js/env.js`:
   ```js
   const ENV = {
     API_HOST: 'ip-del-backend',
     AUTH_PORT: 8081,
     REGISTER_PORT: 8089,
     COMPENDIUM_PORT: 8090,
     CHAT_PORT: 8086,
     CHARACTER_PORT: 8082
   };
   ```

3. Servi i file con un qualsiasi server HTTP statico:
   ```bash
   # Con Python
   python3 -m http.server 8080

   # Con Node.js
   npx serve .
   ```

4. Apri `http://localhost:8080` nel browser.

## Licenza

Tutti i diritti riservati.
