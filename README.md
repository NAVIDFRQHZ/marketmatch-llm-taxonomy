# MarketMatch LLM Taxonomy Drilldown (Experimental)

Firebase Hosting + Cloud Functions (Node 18) prototype for an LLM-generated, progressive taxonomy drilldown.

## Local development (Cloud Shell recommended)

Install dependencies:

npm install  
cd functions && npm install && cd ..

Start emulators:

firebase emulators:start

Open in browser:

http://localhost:5000

### Stub test

With emulators running:

npm run test:stub

## Deploy

firebase login  
firebase use --add  
firebase deploy

