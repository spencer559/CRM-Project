'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---- the toolbar shortcut menu ------------------------------------------------------------
   A DOM small enough to reason about: elements, listeners, focus, and the one <select> behaviour
   that matters here — a value only sticks when a matching option exists. */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.hidden = false; this.disabled = false; this.className = '';
    this.classList={add(){},remove(){}}; this._text = ''; this._value = ''; this.parent = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get value() { return this._value; }
  set value(v) {
    if (this.tagName !== 'SELECT') { this._value = String(v); return; }
    this._value = this.children.some(c => c.value === String(v)) ? String(v) : '';
  }
  appendChild(child) {
    this.children.push(child); child.parent = this;
    if (this.tagName === 'SELECT' && this.children.length === 1) this._value = child.value;
    return child;
  }
  replaceChildren(...kids) { this.children = []; this._value = ''; kids.forEach(k => this.appendChild(k)); return undefined; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  getAttribute(name) { return this.attrs[name]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  focus() { document.activeElement = this; }
  fire(type, ev) {
    const event = Object.assign({ target: this }, ev);
    (this.listeners[type] || []).forEach(fn => fn(event));
    (document.handlers[type] || []).forEach(fn => fn(event));
  }
  labels() { return this.children.map(c => c.textContent); }
}
const document = {
  body: new El('body'),
  activeElement: null,
  handlers: {},
  createElement: tag => new El(tag),
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter(h => h !== fn); }
};
const toolbar = new El('span');
const sandbox = { window: { CRMPageSelection: require('../src/pdf-page-selection') }, document };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/pdf-egm-navigation.js'), 'utf8'), sandbox);

const assigned=[],removed=[],reordered=[],printed=[];
let page=1,restored=null,wentTo=[];
const nav=sandbox.window.CRMEgmNavigation.mount({doc:{numPages:12},toolbar,
 goTo:p=>{wentTo.push(p);page=p},position:()=>({page,zoom:2,x:5,y:6}),restore:p=>{restored=p;page=p.page},
 onAssign:(id,p,selection)=>assigned.push({id,p,...selection}),onRemove:(p,id)=>removed.push({p,id}),
 onReorder:ids=>reordered.push(ids),onPrint:pages=>printed.push(pages)});
const [trigger,back]=toolbar.children,menu=document.body.children[0];
const [saveRow,nameWrap,rangeRow,error,list,empty,printRow]=menu.children;
const [target,save]=saveRow.children,name=nameWrap.children[1],range=rangeRow.children[0].children[1];
const dest=()=>list.children.map(row=>row.children[2].textContent);
assert.equal(trigger.hidden,true);assert.equal(menu.hidden,true);assert.equal(toolbar.children.length,2);
nav.setEpisodes([{id:'ep-1',label:'#1 NS-VT',page:null},{id:'ep-2',label:'#2 AF',page:4}]);
trigger.fire('click');assert.equal(document.activeElement,target);
name.value='Quick look';range.value='1-3, 8';save.fire('click');
assert.deepEqual(assigned.at(-1),{id:null,p:1,pages:[1,2,3,8],label:'Quick look',savedId:null});
assert.equal(menu.hidden,true);
trigger.fire('click');range.value='1-99';save.fire('click');assert.equal(assigned.length,1);assert.equal(error.hidden,false);
range.value='2-3';rangeRow.children[1].fire('click');assert.equal(range.value,'1–3');
range.value='';target.value='ep-1';target.fire('change');save.fire('click');assert.equal(assigned.at(-1).id,'ep-1');
nav.setMarks([{id:'mark-a',pages:[1,2,3],page:1,label:'Quick look'}, {id:'mark-b',page:8,label:'Settings'}]);
assert.equal(trigger.textContent,'EGM · 3');
trigger.fire('click');assert.deepEqual(dest(),['Quick look · p. 1–3','#2 AF · p. 4','Settings · p. 8']);
// Editing a named shortcut updates it in place; no second PDF or duplicate shortcut.
list.children[0].children[3].fire('click');name.value='Overview';range.value='1-2';save.fire('click');
assert.equal(assigned.at(-1).savedId,'mark-a');assert.equal(assigned.at(-1).label,'Overview');
// Drag order is explicit, independent of physical page order.
trigger.fire('click');list.children[2].children[0].fire('dragstart',{dataTransfer:{setData(){}}});
list.children[0].fire('drop',{preventDefault(){}});
assert.deepEqual(reordered.at(-1),['mark-b','mark-a','ep-2']);
assert.equal(dest()[0],'Settings · p. 8');
// Print selection deduplicates overlapping pages and follows the list, not the page numbers.
assert.equal(printRow.children[0].textContent,'5 / 12 pages');
assert.equal(printRow.children[0].title,'8, 1–4','the summary reads in print order');
printRow.children[1].fire('click');
Promise.resolve().then(()=>{assert.deepEqual(printed[0],[8,1,2,3,4],'the dragged order is the printed order');});
list.children[0].children[1].checked=false;list.children[0].children[1].fire('change');
assert.equal(printRow.children[0].textContent,'4 / 12 pages','unchecking drops that shortcut from the selection');
list.children[0].children[2].fire('click');assert.equal(wentTo.at(-1),8);assert.equal(menu.hidden,true);
back.fire('click');assert.deepEqual(restored,{page:1,zoom:2,x:5,y:6});
trigger.fire('click');list.children[0].children[4].fire('click');assert.deepEqual(removed.at(-1),{p:8,id:'mark-b'});
assert.equal(menu.hidden,false);
document.handlers.keydown[0]({key:'Escape',target:menu,preventDefault(){},stopImmediatePropagation(){}});
assert.equal(menu.hidden,true);assert.equal(document.activeElement,trigger);
nav.dispose();assert.equal(document.body.children.length,0);assert.equal(toolbar.children.length,0);

/* ---- the Schedule bridge, with live and obsolete frames ---------------------------------- */
const schedule = fs.readFileSync(path.join(__dirname, '../protected/Patient_Schedule.html'), 'utf8');
const begin = schedule.indexOf('  window.addEventListener("message", function (ev) {', schedule.indexOf('function notifyEgmAvailability'));
const end = schedule.indexOf('\n  });', begin) + 6;
let handler;
const outgoing = [], toReport = [], reportWindow = { postMessage: m => toReport.push(m) }, pdfWindow = { postMessage: (...args) => outgoing.push(args) };
const panel = { frame: { contentWindow: reportWindow }, tr: { querySelector: () => ({ contentWindow: pdfWindow }) }, viewDocId: 'current', egmReady: false };
let notified = 0;
const context = { window: { addEventListener: (_, cb) => { handler = cb; } }, location: { origin: 'https://local.test' }, panel,
  reportBuild: null, notifyEgmAvailability: () => notified++ };
vm.runInNewContext(schedule.slice(begin, end), context);
function send(source, type, id, origin = 'https://local.test') { handler({ source, origin, data: { type, id } }); }
send(pdfWindow, 'pdfviewer:egm-ready', 'old');
send({}, 'pdfviewer:egm-ready', 'current');
send(pdfWindow, 'pdfviewer:egm-ready', 'current', 'https://other.test');
assert.equal(notified, 0);
send(pdfWindow, 'pdfviewer:egm-ready', 'current');
assert.equal(notified, 1); assert.equal(panel.egmReady, true);
const key = 'sha256:' + 'a'.repeat(64);
function message(source, data) { handler({ source, origin: 'https://local.test', data }); }
message(pdfWindow, { type: 'pdfviewer:egm-ready', id: 'current', documentKey: key });
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'old', documentKey: key, entryId: 'ep-1', page: 3 });
message({}, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: 'ep-1', page: 3 });
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: 'wrong', entryId: 'ep-1', page: 3 });
assert.equal(toReport.length, 0, 'stale or unrelated viewers cannot change episode links');
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: 'ep-1', page: 3 });
assert.equal(toReport[0].type, 'crm:egm-assign'); assert.equal(toReport[0].page, 3);
message(pdfWindow, { type: 'pdfviewer:egm-assign', id: 'current', documentKey: key, entryId: null, page: 5 });
assert.equal(toReport[1].entryId, null, 'an unassigned save reaches the report as its own kind of assignment');
message(pdfWindow, { type: 'pdfviewer:egm-remove', id: 'current', documentKey: key, page: 3 });
assert.equal(toReport[2].type, 'crm:egm-remove');
message(reportWindow, { type: 'crm:egm-entries', id: 'old', documentKey: key, entries: [] });
assert.equal(outgoing.length, 0);
message(reportWindow, { type: 'crm:egm-entries', id: 'current', documentKey: key, entries: [{ id: 'ep-1', label: 'x', page: 3 }], marks: [5] });
assert.equal(outgoing[0][0].type, 'pdfviewer:egm-entries'); assert.deepEqual(outgoing[0][0].marks, [5]);
message(reportWindow, { type: 'crm:egm-entries', id: 'current', documentKey: key, entries: [] });
assert.deepEqual(outgoing[1][0].marks, [], 'a report with no marks field must not resurrect the last one');
let warning = '', loaded = '';
context.setWsStatus = text => warning = text;
context.panelViewFile = name => { loaded = name; panel.egmReady = false; panel.pendingEgmLink = null; panel.viewFileName = name; };
const selector = { value: '', options: [{ value: 'source.pdf' }, { value: 'other.pdf' }] };
panel.tr.querySelector = sel => sel === '[data-panel-view]' ? selector : sel === '.crm-panel' ? { classList: { contains: () => true } } : { contentWindow: pdfWindow };
panel.viewFileName = 'source.pdf';
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: key, file: 'source.pdf', page: 3 } });
assert.equal(outgoing[2][0].type, 'pdfviewer:egm-jump');
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: 'sha256:' + 'b'.repeat(64), file: 'source.pdf', page: 3 } });
assert.match(warning, /changed/); assert.equal(outgoing.length, 3);
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: key, file: 'missing.pdf', page: 3 } });
assert.match(warning, /no longer/);
message(reportWindow, { type: 'crm:egm-open-link', link: { documentKey: key, file: 'other.pdf', page: 5 } });
assert.equal(loaded, 'other.pdf'); assert.equal(panel.pendingEgmLink.page, 5);
message(pdfWindow, { type: 'pdfviewer:egm-ready', id: 'current', documentKey: key });
assert.equal(outgoing[3][0].page, 5); assert.equal(panel.pendingEgmLink, null);
console.log('PASS EGM shortcut menu and active-document bridge');

message(pdfWindow,{type:'pdfviewer:egm-reorder',id:'current',documentKey:key,ids:['mark-a','ep-1']});
assert.equal(toReport.at(-1).type,'crm:egm-reorder'); assert.deepEqual(toReport.at(-1).ids,['mark-a','ep-1']);
message(pdfWindow,{type:'pdfviewer:egm-assign',id:'current',documentKey:key,page:1,pages:[1,2],label:'Summary',savedId:'mark-a'});
assert.deepEqual(toReport.at(-1).pages,[1,2]); assert.equal(toReport.at(-1).label,'Summary');
