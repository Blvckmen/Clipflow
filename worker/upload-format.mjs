// Container signatures only; the worker still probes and validates the media before processing it.
export function videoContainer(bytes) {
 if(bytes.length<12)return false;
 if(bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3)return true;
 const atom=String.fromCharCode(...bytes.slice(4,8));
 return ["ftyp","moov","mdat","wide","free","skip"].includes(atom);
}
