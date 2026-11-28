/** Display-only representation. Never use this text for exports or mutations.
 * JSON string syntax distinguishes actual control characters from literal escapes.
 * JSON.stringify does not escape C1/BOM/bidi controls, so encode those as legal
 * JSON unicode escapes too. JSON.parse(text) still recovers the exact input. */
export function resultCellDisplay(value:unknown):{text:string;escaped:boolean}{
 const escaped=typeof value==='string'&&/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufeff\u202a-\u202e\u2066-\u2069]/u.test(value);
 return {escaped,text:escaped?JSON.stringify(value).replace(/[\u007f-\u009f\ufeff\u202a-\u202e\u2066-\u2069]/gu,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0')):value===null?'NULL':String(value??'')};
}
