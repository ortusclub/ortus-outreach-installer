// Decode JPEG frames even when multipart headers or images span network chunks.
export function createJpegDecoder(onFrame) {
  let buffer = new Uint8Array();
  return chunk => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer); merged.set(chunk, buffer.length); buffer = merged;
    let start = -1;
    for (let i=0;i<buffer.length-1;i++) {
      if (start < 0 && buffer[i]===255 && buffer[i+1]===216) { start=i; i++; }
      else if (start>=0 && buffer[i]===255 && buffer[i+1]===217) {
        onFrame(buffer.slice(start,i+2)); buffer=buffer.slice(i+2); i=-1; start=-1;
      }
    }
    if(start>0) buffer=buffer.slice(start);
    else if(start<0) buffer=buffer.slice(-1);
    if(buffer.length>8*1024*1024) throw Error('Preview frame too large');
  };
}
