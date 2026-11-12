import languages from './languages.json' with {type:'json'};
import {AppError} from './errors.js';
export {languages};
export const languageKeys = Object.keys(languages);
export const locales = [...new Set(Object.values(languages).map(l=>l.locale))];
export const acknowledgements = new Set(['yes','okay','ok','sure','thanks','thank you','ஆம்','சரி','நன்றி','হ্যাঁ','हाँ','हां','जी','ठीक है','हूँ','हां जी','హా','అవును','ಸರಿ']);
export function isAcknowledgement(text) {return acknowledgements.has(text.toLowerCase().trim().replace(/[.!?,।…\s]+$/u,''));}
export function scriptCandidates(text) {
  const counts = Object.entries(languages).filter(([k])=>k!=='hinglish').map(([k,l])=>[k,[...text].filter(c=>/\p{L}/u.test(c)&&new RegExp(l.recognitionPattern,'u').test(c)).length]);
  const max=Math.max(0,...counts.map(x=>x[1])); return counts.filter(x=>max&&x[1]===max).map(x=>x[0]);
}
export function scriptMatches(text,key) {
  const chars=[...text].filter(c=>/\p{L}/u.test(c)); if(!chars.length)return true;
  const expected=chars.filter(c=>new RegExp(languages[key].pattern,'u').test(c)).length;
  return expected>0 && expected>=chars.length-expected;
}
export function chooseLanguage(result,text,detected) {
  if(typeof result.explicit_request!=='boolean'||![...languageKeys,'unsupported'].includes(result.language)) throw new AppError(502,'LANGUAGE_ERROR','Could not determine the reply language. Select a language explicitly.');
  let selected=result.language;
  if(!result.explicit_request) {
    const match=Object.entries(languages).find(([k,l])=>k!=='hinglish'&&l.code===detected)?.[0];
    const candidates=scriptCandidates(text);
    if(match && (candidates.includes(match)||!candidates.length||(candidates.length===1&&candidates[0]==='english'))) selected=match==='hindi'&&selected==='hinglish'?'hinglish':match;
    else if(candidates.length===1&&candidates[0]!=='english') selected=candidates[0];
    else if(['bho','ks','bhb','bgc','mag','hne'].includes(detected)) selected='unsupported';
  }
  if(!languages[selected]) throw new AppError(422,'LANGUAGE_UNAVAILABLE','This language has no supported Parler voice route. Select another reply language.');
  return selected;
}
