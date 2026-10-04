import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dataPath} from './paths.js';
const file=()=>dataPath('campaign-board-deletions.json');
export function getCampaignDeletions(){return existsSync(file())?JSON.parse(readFileSync(file(),'utf8')):[];}
export function deleteCampaignFromBoard(entry){
 const rows=getCampaignDeletions();
 rows.push({...entry,deletedAt:new Date().toISOString()});
 const tmp=file()+'.tmp';writeFileSync(tmp,JSON.stringify(rows,null,2));renameSync(tmp,file());return rows;
}
