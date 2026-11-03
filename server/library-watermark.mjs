import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {PDFDocument,rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import sharp from 'sharp';
import {HttpError} from './errors.mjs';

export const MAX_LIBRARY_BYTES=8*1024*1024;
export const MAX_LIBRARY_PAGES=200;
export const MAX_LIBRARY_PIXELS=30*1024*1024;
const fontPath=fileURLToPath(new URL('./fonts/NotoSansSC.ttf',import.meta.url));
let fontBytes;
const markup=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function libraryFileType(body,name) {
  const lower=String(name).toLowerCase();
  if(body.length>=5&&body.subarray(0,5).toString()==='%PDF-'&&lower.endsWith('.pdf'))return {type:'application/pdf',ext:'.pdf'};
  if(body.length>=8&&body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&lower.endsWith('.png'))return {type:'image/png',ext:'.png'};
  if(body.length>=3&&body[0]===255&&body[1]===216&&body[2]===255&&/\.jpe?g$/.test(lower))return {type:'image/jpeg',ext:'.jpg'};
  throw new HttpError(400,'一期仅支持实际格式与扩展名一致的PDF、PNG、JPEG文件','library_format');
}
function visibleBox(page) {
  const media=page.getMediaBox(),crop=page.getCropBox();
  const x=Math.max(media.x,crop.x),y=Math.max(media.y,crop.y),right=Math.min(media.x+media.width,crop.x+crop.width),top=Math.min(media.y+media.height,crop.y+crop.height);
  if(![x,y,right,top].every(Number.isFinite)||right<=x||top<=y)throw new HttpError(400,'PDF页面没有有效可见区域','library_pdf_invalid');
  return {x,y,width:right-x,height:top-y};
}
async function pdf(body) {
  try {
    const document=await PDFDocument.load(body);
    if(document.getPageCount()<1||document.getPageCount()>MAX_LIBRARY_PAGES)throw new HttpError(400,'PDF须为1至200页','library_pdf_pages');
    document.getPages().forEach(visibleBox);
    return document;
  } catch(error) {
    if(error instanceof HttpError)throw error;
    throw new HttpError(400,'PDF无法读取或已加密，请上传可读取的PDF','library_pdf_invalid');
  }
}
export async function validateLibraryFile(body,detected) {
  if(detected.type==='application/pdf'){await pdf(body);return;}
  if(detected.type==='image/png')for(let at=8;at+12<=body.length;){
    const length=body.readUInt32BE(at);if(length>body.length-at-12)break;
    const chunk=body.toString('ascii',at+4,at+8);
    if(chunk==='acTL')throw new HttpError(400,'一期仅支持静态PNG图片','library_image_invalid');
    if(chunk==='IEND')break;at+=length+12;
  }
  try {
    const image=sharp(body,{limitInputPixels:MAX_LIBRARY_PIXELS,animated:false}),meta=await image.metadata();
    if(!meta.width||!meta.height||meta.width*meta.height>MAX_LIBRARY_PIXELS||(meta.pages||1)>1)throw new Error('image bounds');
    // Decode once at upload rather than accepting a truncated file by its header.
    await image.stats();
  } catch {throw new HttpError(400,'图片无法读取、为多帧图片或像素超过30MP','library_image_invalid');}
}
export async function watermarkLibraryFile(body,type,label) {
  if(type==='application/pdf') {
    const document=await pdf(body);
    document.registerFontkit(fontkit);
    fontBytes=fontBytes||await readFile(fontPath);
    const font=await document.embedFont(fontBytes,{subset:true});
    for(const page of document.getPages()) {
      // CropBox is the visible page, not necessarily the whole MediaBox.
      // The viewer rotates this region and its content together, so coordinates
      // inside it remain visible for 90/180/270-degree page rotations as well.
      const box=visibleBox(page),usableWidth=box.width*.84;
      let size=Math.min(22,box.width/30,box.height/16),lines,lineHeight;
      function wrap(value) {
        const out=[];let line='';
        for(const character of Array.from(String(value).replace(/\s+/g,' '))) {
          if(line&&font.widthOfTextAtSize(line+character,size)>usableWidth){out.push(line);line=character;}
          else line+=character;
        }
        if(line)out.push(line);return out;
      }
      for(let pass=0;pass<8;pass++){
        lines=wrap(label).concat(wrap('正弘置业 项目共享资料'));
        lineHeight=font.heightAtSize(size)*1.1;
        if(lines.length*lineHeight<=box.height*.7)break;
        size*=.7;
      }
      const blockHeight=lines.length*lineHeight,centres=blockHeight<box.height*.18?[.22,.5,.78]:[.5];
      centres.forEach(centre=>lines.forEach((line,index)=>page.drawText(line,{
        x:box.x+(box.width-font.widthOfTextAtSize(line,size))/2,
        y:box.y+box.height*centre+(lines.length-1)*lineHeight/2-index*lineHeight,
        size,font,color:rgb(.65,.12,.12),opacity:.24
      })));
    }
    return Buffer.from(await document.save());
  }
  try {
    const image=sharp(body,{limitInputPixels:MAX_LIBRARY_PIXELS,animated:false}).rotate(),meta=await image.metadata();
    const rotated=meta.orientation>=5&&meta.orientation<=8,width=(rotated?meta.height:meta.width)||500,height=(rotated?meta.width:meta.height)||500;
    const size=Math.max(10,Math.min(60,Math.round(width/30)));
    const textImage=await sharp({text:{text:'<span foreground="#9c1b1b" alpha="52%">'+markup(label)+'</span>',font:'Noto Sans SC '+size,
      fontfile:fontPath,width:Math.max(80,Math.round(width*.84)),rgba:true,align:'center',spacing:6}}).png().toBuffer();
    const overlay=await sharp(textImage).resize({width:width,height:height,fit:'inside',withoutEnlargement:true}).png().toBuffer();
    const composed=image.composite([{input:overlay,gravity:'centre'}]);
    return type==='image/png'?await composed.png().toBuffer():await composed.jpeg({quality:92}).toBuffer();
  } catch {throw new HttpError(400,'图片水印生成失败，请联系管理员核对文件','library_watermark_failed');}
}
