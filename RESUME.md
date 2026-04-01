# ElevenLabs Integration — Resume Point

## What's Done
- Google Sheet "Ortus ElevenLabs Calling" created: `1qBjityRlSsRfRLXJN7yv_J_yoNElkdzL1fOE0jh_OoU`
- Apps Script deployed as web app (project: `1FxYM43Yi-OMXuFOwiYCPKs-tKs0BaUG2IzrBo3AVlvnnl_TFuYwVrxPL`)
- ElevenLabs API key created (unrestricted): `sk_24138756ab4b5a842c6d44cf1851b5536931888de6752303`
- Twilio number imported: +1 617 600 0320 (`phnum_8701kn1e7q5rfbgsrwp8xzfk1dad`)
- Agent: `agent_5601kmzey4mve8pswpwvmhckcgnr` / branch: `agtbrch_0801kmzey97dfhwbwgctcmkv4ez4`
- Batch calling T&C accepted
- Voice updated via API to Alice (British, Clear) — voice_id `Xb7hH8MSUJpSbSDYk0k2`
- Variable mapping fix written to local file `elevenlabs-apps-script.js`

## What Still Needs To Be Done

### Task 1: Update Apps Script code in browser
The local file `elevenlabs-apps-script.js` has the critical variable mapping fix but has NOT yet been pasted into the Apps Script editor.

**The fix**: Dynamic variables were passed as top-level keys on the recipient object. ElevenLabs requires them nested inside `conversation_initiation_client_data.dynamic_variables`. This is why the agent was ignoring sidebar inputs (host name, event name, etc).

Steps using computer-use:
1. Open Apps Script editor: https://script.google.com/u/0/home/projects/1FxYM43Yi-OMXuFOwiYCPKs-tKs0BaUG2IzrBo3AVlvnnl_TFuYwVrxPL/edit
2. Click in code editor, Cmd+A to select all, delete
3. Run: `cat /Users/antoniovarlese/ortus-gologin-clone/elevenlabs-apps-script.js | pbcopy`
4. Cmd+V to paste, Cmd+S to save
5. No redeployment needed — sidebar uses HEAD deployment

### Task 2: Publish the agent to make voice change live
Voice was updated via API (Alice - British) but needs publishing for production batch calls.

Steps:
1. Go to: https://elevenlabs.io/app/agents/agents/agent_5601kmzey4mve8pswpwvmhckcgnr
2. Click "Publish" button (top right), review changes, click "Publish"

### Task 3: Test
1. Go to Google Sheet, clear Call Status/Date/Batch ID from row 2
2. Open sidebar, fill event details, Submit Batch Call
3. Verify variables are injected correctly AND voice is crisp British English

## Root Causes Found
1. **Voice sounded French**: "Sarah" voice had language="fr". Fixed → Alice (British).
2. **Variables not mapping**: Flat recipient object → needs `conversation_initiation_client_data.dynamic_variables` nesting.
3. **First API key invalid**: Truncated from screenshot. Created new unrestricted key.
