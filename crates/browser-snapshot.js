// Fixed extraction code, never supplied by a model or an external page.
(() => {
  try {
    const root = (document.querySelector('article') || document.querySelector('main') || document.body)?.cloneNode(true);
    root?.querySelectorAll('script,style,noscript,template,form,input,textarea,select,button').forEach(n => n.remove());
    const full = (root?.textContent || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map((a, id) => ({id, text:(a.textContent || '').trim().slice(0, 240), url:a.href})).filter(a => /^https?:\/\//i.test(a.url));
    return {url:location.href, title:document.title.slice(0, 512), text:full.slice(0, 524288), clipped:full.length > 524288,
      headings:Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0,200).map(h => ({level:Number(h.tagName.slice(1)),text:(h.textContent || '').trim().slice(0,512)})), links};
  } catch (_) { return {isError:true,error:{code:'page_unreadable',message:'页面不允许提取正文，请手动打开查看'}}; }
})()
