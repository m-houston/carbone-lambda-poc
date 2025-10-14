/**
 * Client-side script for the Template Data Builder form (externalized)
 */

const App = {
  elements: {
    statusContainer: document.getElementById('status-container'),
    rowsEl: document.getElementById('rows'),
    addBtn: document.getElementById('add-field'),
    clearBtn: document.getElementById('clear-fields'),
    previewEl: document.getElementById('preview'),
    hidden: document.getElementById('dataJsonHidden'),
    errorsEl: document.getElementById('validationErrors'),
    submitBtn: document.getElementById('submitBtn'),
    advToggle: document.getElementById('advancedMode'),
    advTA: document.getElementById('advancedTextarea'),
    advErr: document.getElementById('advancedError'),
    previewStatus: document.getElementById('preview-status'),
    footerInfo: document.getElementById('footer-info'),
    templateSelect: document.getElementById('templateSelect'),
    templateMarkersInfo: document.getElementById('templateMarkersInfo')
  },
  config: { MAX_FIELDS: 50, AVAILABLE_TYPES: ['string','number','boolean','date'] },
  state: {
    fields: [
      { key: 'fullName', type: 'string', value: 'John Smith' },
      { key: 'firstName', type: 'string', value: 'John' },
      { key: 'lastName', type: 'string', value: 'Smith' },
      { key: 'nhsNumber', type: 'string', value: '9990000000' },
      { key: 'address_line_1', type: 'string', value: 'Mr John Smith' },
      { key: 'address_line_2', type: 'string', value: '221B Baker Street' },
      { key: 'address_line_3', type: 'string', value: 'London' },
      { key: 'address_line_4', type: 'string', value: 'NW1 6XE' },
      { key: 'address_line_5', type: 'string', value: 'United Kingdom' },
      { key: 'address_line_6', type: 'string', value: '' },
      { key: 'address_line_7', type: 'string', value: '' },
      { key: 'date', type: 'date', value: new Date().toISOString().substring(0,10) }
    ],
    isTemplateValid: false,
    isLoReady: false,
    builtAt: '',
    nodeVersion: '',
    templateName: '',
    availableTemplates: []
  },
  init(serverData) {
    this.state.isTemplateValid = serverData.isTemplateValid;
    this.state.isLoReady = serverData.isLoReady;
    this.state.builtAt = serverData.builtAt;
    this.state.nodeVersion = serverData.nodeVersion;
    this.updateStatusDisplay();
    this.updateFooter();
    const urlParams = new URLSearchParams(window.location.search);
    const password = urlParams.get('password');
    if (password) document.getElementById('passwordHidden').value = password;
    this.setupEventListeners();
    this.renderRows();
    this.fetchTemplates();
  },
  updateStatusDisplay() {
    const { isLoReady, isTemplateValid } = this.state;
    const statusEl = this.elements.statusContainer;
    if (isLoReady && isTemplateValid) statusEl.classList.add('ok'); else statusEl.classList.remove('ok');
    statusEl.innerHTML = '<strong>Status:</strong> Template: ' + (isTemplateValid ? 'OK' : 'Missing') + ' | Engine: ' + (isLoReady ? 'Ready' : 'Not initialised');
  },
  updateFooter() { this.elements.footerInfo.textContent = 'Built: ' + this.state.builtAt + ' • Node ' + this.state.nodeVersion; },
  setupEventListeners() {
    this.elements.rowsEl.addEventListener('input', this.handleRowInput.bind(this));
    this.elements.rowsEl.addEventListener('click', this.handleRowClick.bind(this));
    this.elements.addBtn.addEventListener('click', this.handleAddField.bind(this));
    this.elements.clearBtn.addEventListener('click', this.handleClearFields.bind(this));
    this.elements.advToggle.addEventListener('change', this.handleAdvancedModeToggle.bind(this));
    this.elements.advTA.addEventListener('input', this.handleAdvancedInput.bind(this));
    document.getElementById('data-form').addEventListener('submit', this.handleSubmit.bind(this));
    this.elements.templateSelect.addEventListener('change', this.handleTemplateChange.bind(this));
  },
  async fetchTemplates() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const password = urlParams.get('password');
      const resp = await fetch('/templates' + (password ? ('?password=' + encodeURIComponent(password)) : ''));
      if (!resp.ok) throw new Error('Failed to load templates');
      const json = await resp.json();
      this.state.availableTemplates = json.templates || [];
      this.populateTemplateSelect();
    } catch { this.elements.templateMarkersInfo.textContent = 'Template list load failed'; }
  },
  populateTemplateSelect() {
    const sel = this.elements.templateSelect; sel.innerHTML='';
    this.state.availableTemplates.forEach(t => { const opt=document.createElement('option'); opt.value=t.name; opt.textContent=t.name + ' (' + t.markers.length + ' markers)'; sel.appendChild(opt); });
    if (this.state.availableTemplates.length) { this.state.templateName=this.state.availableTemplates[0].name; sel.value=this.state.templateName; this.applyMarkersForTemplate(); }
  },
  handleTemplateChange() { this.state.templateName = this.elements.templateSelect.value; this.applyMarkersForTemplate(); },
  applyMarkersForTemplate() {
    const tpl = this.state.availableTemplates.find(t => t.name === this.state.templateName); if (!tpl) return;
    const existing = new Map(this.state.fields.map(f => [f.key, f])); const newFields=[];
    tpl.markers.forEach(marker => { if (existing.has(marker)) newFields.push(existing.get(marker)); else newFields.push({ key: marker, type: 'string', value: '(( ' + marker + ' ))' }); });
    this.state.fields = newFields; this.elements.templateMarkersInfo.textContent = tpl.markers.length + ' markers'; this.renderRows();
  },
  handleRowInput(e) { const tr=e.target.closest('tr'); if(!tr) return; const idx=Number(tr.dataset.index); if(e.target.classList.contains('k-in')) this.state.fields[idx].key=e.target.value; if(e.target.classList.contains('t-in')) { this.state.fields[idx].type=e.target.value; this.renderRows(); return;} if(e.target.classList.contains('v-in')) this.state.fields[idx].value=e.target.value; this.validate(); },
  handleRowClick(e){ if(e.target.classList.contains('rm')) { const tr=e.target.closest('tr'); const idx=Number(tr.dataset.index); this.state.fields.splice(idx,1); this.renderRows(); } },
  handleAddField(){ if(this.state.fields.length>=this.config.MAX_FIELDS){ alert('Field limit reached'); return;} this.state.fields.push({ key:'', type:'string', value:''}); this.renderRows(); setTimeout(()=>{ const rows=this.elements.rowsEl.querySelectorAll('tr'); const lastRow=rows[rows.length-1]; const keyInput=lastRow?.querySelector('.k-in'); if(keyInput) keyInput.focus(); },0); },
  handleClearFields(){ if(!confirm('Clear all fields?')) return; this.state.fields=[]; this.renderRows(); },
  handleAdvancedModeToggle(){ if(this.elements.advToggle.checked){ this.elements.advTA.style.display='block'; this.elements.advTA.value=this.elements.previewEl.textContent||'{\n  "data": {}\n}'; this.handleAdvancedInput(); } else { try { const parsed=JSON.parse(this.elements.advTA.value); if(parsed && typeof parsed==='object' && !Array.isArray(parsed) && parsed.data && typeof parsed.data==='object' && !Array.isArray(parsed.data)){ this.state.fields=Object.entries(parsed.data).map(([k,v])=>this.inferField(k,v)); this.elements.advErr.style.display='none'; this.elements.advTA.style.display='none'; this.renderRows(); } else { throw new Error('Root must be an object with a data object property'); } } catch(err){ this.elements.advErr.textContent=err.message; this.elements.advErr.style.display='block'; this.elements.advToggle.checked=true; } } },
  handleAdvancedInput(){ try { const parsed=JSON.parse(this.elements.advTA.value); if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('Must be an object'); if(!parsed.data || typeof parsed.data!=='object' || Array.isArray(parsed.data)) throw new Error('Must have a "data" object property'); this.elements.advErr.style.display='none'; this.elements.submitBtn.disabled=false; this.elements.previewEl.textContent=this.elements.advTA.value; this.elements.previewStatus.textContent='OK'; this.elements.previewStatus.style.background='#e0f5e9'; } catch(err){ this.elements.advErr.textContent=err.message; this.elements.advErr.style.display='block'; this.elements.submitBtn.disabled=true; this.elements.previewStatus.textContent='ERROR'; this.elements.previewStatus.style.background='#fdd'; } },
  handleSubmit(e){ if(this.elements.advToggle.checked){ try { const parsed=JSON.parse(this.elements.advTA.value); if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('Must be an object'); if(!parsed.data || typeof parsed.data!=='object' || Array.isArray(parsed.data)) throw new Error('Must have a "data" object property'); this.elements.hidden.value=this.elements.advTA.value; this.elements.previewEl.textContent=this.elements.advTA.value; this.elements.advErr.style.display='none'; } catch(err){ e.preventDefault(); this.elements.advErr.textContent='Invalid JSON: '+err.message; this.elements.advErr.style.display='block'; return; } } else { this.updatePreview(); } },
  renderRows(){ const rowsEl=this.elements.rowsEl; rowsEl.innerHTML=''; if(this.state.fields.length===0){ const tr=document.createElement('tr'); tr.innerHTML='<td colspan="4"><em>No custom fields. Defaults will be used.</em></td>'; rowsEl.appendChild(tr);} else { this.state.fields.forEach((field,index)=>{ const tr=document.createElement('tr'); tr.dataset.index=index; const typeOptions=this.config.AVAILABLE_TYPES.map(type=>'<option value="'+type+'" '+(type===field.type?'selected':'')+'>'+type+'</option>').join(''); tr.innerHTML='<td><input type="text" class="k-in" value="'+this.escapeHtml(field.key)+'" aria-label="Key" /></td><td><select class="t-in" aria-label="Type">'+typeOptions+'</select></td><td>'+this.valueInputHtml(field)+'</td><td><button type="button" class="btn danger rm" aria-label="Remove field">×</button></td>'; rowsEl.appendChild(tr); }); } this.validate(); },
  valueInputHtml(field){ if(field.type==='boolean'){ return '<select class="v-in" aria-label="Boolean value"><option value="true" '+(String(field.value)==='true'?'selected':'')+'>true</option><option value="false" '+(String(field.value)==='false'?'selected':'')+'>false</option></select>'; } if(field.type==='date'){ return '<input type="date" class="v-in" value="'+String(field.value||'').substring(0,10)+'" />'; } if(field.type==='number'){ return '<input type="number" step="any" class="v-in" value="'+(field.value!==undefined?String(field.value):'')+'" />'; } return '<input type="text" class="v-in" value="'+this.escapeHtml(field.value??'')+'" />'; },
  collect(){ const keyCounts={}; const dataObj={}; const errors=[]; this.state.fields.forEach(f=>{ keyCounts[f.key]=(keyCounts[f.key]||0)+1; }); this.state.fields.forEach(f=>{ if(!f.key.trim()) return; if(keyCounts[f.key]>1) return; let v=f.value; if(f.type==='number'){ const n=parseFloat(v); if(!Number.isFinite(n)){ errors.push('Invalid number for key "'+f.key+'"'); return;} v=n;} else if(f.type==='boolean'){ v=String(v)==='true'; } else if(f.type==='date'){ if(!/^\d{4}-\d{2}-\d{2}$/.test(v)){ errors.push('Invalid date format (YYYY-MM-DD) for key "'+f.key+'"'); return;} } dataObj[f.key]=v; }); Object.entries(keyCounts).forEach(([k,c])=>{ if(c>1) errors.push('Duplicate key: "'+k+'"'); }); const payload={ data: dataObj }; if(this.state.templateName) payload.template=this.state.templateName; return { errors, payload }; },
  updatePreview(){ const { errors, payload }=this.collect(); if(errors.length){ this.elements.errorsEl.style.display='block'; this.elements.errorsEl.innerHTML=errors.map(e=>'<div>'+this.escapeHtml(e)+'</div>').join(''); this.elements.previewStatus.textContent='ERROR'; this.elements.previewStatus.style.background='#fdd'; this.elements.submitBtn.disabled=true; } else { this.elements.errorsEl.style.display='none'; this.elements.previewStatus.textContent='OK'; this.elements.previewStatus.style.background='#e0f5e9'; this.elements.submitBtn.disabled=false; } this.elements.previewEl.textContent=JSON.stringify(payload,null,2); this.elements.hidden.value=this.elements.previewEl.textContent; },
  validate(){ this.updatePreview(); const keyCounts=this.state.fields.reduce((acc,f)=>{ acc[f.key]=(acc[f.key]||0)+1; return acc; },{}); [...this.elements.rowsEl.querySelectorAll('tr')].forEach(tr=>{ const keyInput=tr.querySelector('.k-in'); if(!keyInput) return; const key=keyInput.value; if(key && keyCounts[key]>1) keyInput.classList.add('duplicate'); else keyInput.classList.remove('duplicate'); }); },
  inferField(key,value){ if(typeof value==='number') return { key, type:'number', value }; if(typeof value==='boolean') return { key, type:'boolean', value }; if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { key, type:'date', value }; return { key, type:'string', value }; },
  escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c])); }
};

document.addEventListener('DOMContentLoaded', () => {
  const serverData = window.SERVER_DATA || { isTemplateValid:false, isLoReady:false, builtAt:new Date().toISOString(), nodeVersion:'unknown' };
  App.init(serverData);
});
