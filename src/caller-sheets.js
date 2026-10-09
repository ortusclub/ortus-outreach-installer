import { fetchSheetWithRows } from './sheets.js';
import { normalizeCallerConfig, callerPreview } from '../public/js/caller-sheet-model.mjs';
export function installCallerSheetRoutes(app) {
 app.post('/api/caller/sheet-preview',async(req,res)=>{
  let config;try{config=normalizeCallerConfig(req.body);if(!config.sourceUrl)throw new Error('Add a spreadsheet link first.');}catch(error){return res.status(400).json({error:error.message});}
  try{const rows=await fetchSheetWithRows(config.sourceUrl);res.set('Cache-Control','no-store').json(callerPreview(rows,config));}
  catch{res.status(502).json({error:'Could not read this sheet. Check that the selected tab is accessible to the app and try again.'});}
 });
}
