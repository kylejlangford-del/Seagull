(() => {
  const STORAGE_KEY = 'seagull-prestart-accel-v1';

  // Exact reference values, transcribed from the "TIMINGS START — THE CLASSIC
  // APPROACH" table. `color` is the wind-speed swatch shown on the TWS cell.
  const DEFAULT_ROWS = [
    { tws:'6',  group:'TACK', color:'#a6dd86', entryAbove:'2.05', entryBelow:'1.40', distToLine:'70',      vamosBefore:'15', vamosTime:'24', vamosAfter:'33', ttkLastTack:'18', timeLastTack:'40(18 TTK)', latestBoardUp:'-',  buildAngle:'100', charge:'17 (6 TTK)',   chargeSpeed:'', killRatio:'1:3', noGo1:'-',      noGo2:'0-180',     killHigh1:'18', killHigh2:'' },
    { tws:'7',  group:'TACK', color:'#8fd2df', entryAbove:'2.05', entryBelow:'1.40', distToLine:'100',     vamosBefore:'16', vamosTime:'24', vamosAfter:'32', ttkLastTack:'18', timeLastTack:'40(18 TTK)', latestBoardUp:'-',  buildAngle:'100', charge:'17 (6 TTK)',   chargeSpeed:'25.8', killRatio:'1:3', noGo1:'-',      noGo2:'0-180',     killHigh1:'18', killHigh2:'' },
    { tws:'8',  group:'TACK', color:'#4e9fd6', entryAbove:'2.05', entryBelow:'1.40', distToLine:'100',     vamosBefore:'17', vamosTime:'24', vamosAfter:'31', ttkLastTack:'18', timeLastTack:'40(18 TTK)', latestBoardUp:'20', buildAngle:'90',  charge:'15 (5 TTK)',   chargeSpeed:'27.5', killRatio:'1:3', noGo1:'-',      noGo2:'0-180',     killHigh1:'17', killHigh2:'' },
    { tws:'9',  group:'GYBE', color:'#f0a35c', entryAbove:'2.05', entryBelow:'1.40', distToLine:'170',     vamosBefore:'22', vamosTime:'29', vamosAfter:'36', ttkLastTack:'18', timeLastTack:'40(18 TTK)', latestBoardUp:'20', buildAngle:'90',  charge:'15 (5 TTK)',   chargeSpeed:'29', killRatio:'1:3', noGo1:'-',      noGo2:'0-180',     killHigh1:'17', killHigh2:'' },
    { tws:'10', group:'GYBE', color:'#b8e29a', entryAbove:'1.50', entryBelow:'1.30', distToLine:'200',     vamosBefore:'24', vamosTime:'30', vamosAfter:'36', ttkLastTack:'15', timeLastTack:'35(15 TTK)', latestBoardUp:'15', buildAngle:'90',  charge:'15 (4 TTK)',   chargeSpeed:'30.5', killRatio:'1:3', noGo1:'-',      noGo2:'>80 120<',  killHigh1:'16', killHigh2:'' },
    { tws:'11', group:'GYBE', color:'#8ecb7c', entryAbove:'1.50', entryBelow:'1.30', distToLine:'200',     vamosBefore:'24', vamosTime:'30', vamosAfter:'36', ttkLastTack:'15', timeLastTack:'35(15 TTK)', latestBoardUp:'15', buildAngle:'90',  charge:'13 (4 TTK)',   chargeSpeed:'31.8', killRatio:'1:3', noGo1:'-',      noGo2:'-',         killHigh1:'16', killHigh2:'' },
    { tws:'12', group:'GYBE', color:'#5fa85a', entryAbove:'1.50', entryBelow:'1.30', distToLine:'200',     vamosBefore:'24', vamosTime:'30', vamosAfter:'36', ttkLastTack:'15', timeLastTack:'35(15 TTK)', latestBoardUp:'10', buildAngle:'90',  charge:'12 (3 TTK)',   chargeSpeed:'32.9', killRatio:'1:3', noGo1:'-',      noGo2:'-',         killHigh1:'16', killHigh2:'' },
    { tws:'13', group:'GYBE', color:'#d7de6a', entryAbove:'1.50', entryBelow:'1.30', distToLine:'300',     vamosBefore:'32', vamosTime:'37', vamosAfter:'42', ttkLastTack:'15', timeLastTack:'35(15 TTK)', latestBoardUp:'10', buildAngle:'90',  charge:'10 (3 TTK)',   chargeSpeed:'34', killRatio:'1:3', noGo1:'-',      noGo2:'-',         killHigh1:'16', killHigh2:'' },
    { tws:'14', group:'GYBE', color:'#f4d94f', entryAbove:'1.40', entryBelow:'1.30', distToLine:'300',     vamosBefore:'31', vamosTime:'36', vamosAfter:'41', ttkLastTack:'12', timeLastTack:'30(12 TTK)', latestBoardUp:'10', buildAngle:'70',  charge:'10 (3 TTK)',   chargeSpeed:'34.9', killRatio:'1:3', noGo1:'-',      noGo2:'-',         killHigh1:'17', killHigh2:'' },
    { tws:'15', group:'GYBE', color:'#f7c343', entryAbove:'1.40', entryBelow:'1.30', distToLine:'300',     vamosBefore:'30', vamosTime:'35', vamosAfter:'40', ttkLastTack:'12', timeLastTack:'30(12 TTK)', latestBoardUp:'8',  buildAngle:'70',  charge:'8 (3 TTK)',    chargeSpeed:'35.7', killRatio:'1:3', noGo1:'80-100', noGo2:'-',         killHigh1:'18', killHigh2:'' },
    { tws:'16', group:'GYBE', color:'#f2994a', entryAbove:'1.20', entryBelow:'1.10', distToLine:'300',     vamosBefore:'29', vamosTime:'34', vamosAfter:'39', ttkLastTack:'12', timeLastTack:'30(12 TTK)', latestBoardUp:'6',  buildAngle:'70',  charge:'7 (2,5 TTK)',  chargeSpeed:'36.3', killRatio:'1:3', noGo1:'80-100', noGo2:'-',         killHigh1:'18', killHigh2:'' },
    { tws:'17', group:'GYBE', color:'#ec7c3c', entryAbove:'1.20', entryBelow:'1.10', distToLine:'300-400', vamosBefore:'33', vamosTime:'38', vamosAfter:'43', ttkLastTack:'10', timeLastTack:'30(12 TTK)', latestBoardUp:'6',  buildAngle:'70',  charge:'6 (2,5 TTK)',  chargeSpeed:'36.9', killRatio:'1:3', noGo1:'',        noGo2:'80-100',    killHigh1:'19', killHigh2:'' },
    { tws:'18', group:'GYBE', color:'#e05c4e', entryAbove:'1.20', entryBelow:'1.10', distToLine:'300-400', vamosBefore:'33', vamosTime:'38', vamosAfter:'43', ttkLastTack:'10', timeLastTack:'30',         latestBoardUp:'6',  buildAngle:'70',  charge:'6 (2,5 TTK)',  chargeSpeed:'', killRatio:'1:3', noGo1:'',        noGo2:'80-100',    killHigh1:'19', killHigh2:'' },
  ];

  // Column order + how each is rendered when NOT being edited.
  // redParen: text in "(...)" is picked out in red (e.g. "40(18 TTK)").
  // fullRed: the whole value is rendered red (e.g. the TTK-last-tack column).
  // alwaysVisible: can't be hidden (it's the row identifier). defaultVisible:
  // shown by default; everything else starts hidden behind the column chips.
  const COLUMNS = [
    { key:'tws',           label:'TWS',                            sticky:true, alwaysVisible:true },
    { key:'entryAbove',    label:'ENTRY above pin' },
    { key:'entryBelow',    label:'ENTRY below pin' },
    { key:'distToLine',    label:'Distance to line' },
    { key:'vamosBefore',   label:'Vamos -50m' },
    { key:'vamosTime',     label:'Vamos time' },
    { key:'vamosAfter',    label:'Vamos +50m' },
    { key:'ttkLastTack',   label:'TTK last tack',                  fullRed:true },
    { key:'timeLastTack',  label:'Time Last Tack',                 redParen:true },
    { key:'latestBoardUp', label:'Latest Board up' },
    { key:'buildAngle',    label:'Build Angle',                    defaultVisible:true },
    { key:'charge',        label:'Charge',                         redParen:true, defaultVisible:true },
    { key:'chargeSpeed',   label:'Charge Speed' },
    { key:'killRatio',     label:'KILL RATIO' },
    { key:'noGo1',         label:'No go zone TWA (1 board)' },
    { key:'noGo2',         label:'No go zone TWA (2 boards)' },
    { key:'killHigh1',     label:'Min BSP (1 board)',              defaultVisible:true },
    { key:'killHigh2',     label:'Killing high (2 board)' },
  ];

  const COLS_STORAGE_KEY = 'seagull-prestart-accel-cols-v1';
  const DEFAULT_VISIBLE_KEYS = COLUMNS.filter(c => c.alwaysVisible || c.defaultVisible).map(c => c.key);

  const tableEl = document.getElementById('accelTable');
  const editBtn = document.getElementById('editBtn');
  const resetBtn = document.getElementById('resetBtn');
  const editHint = document.getElementById('editHint');
  const colToggleBar = document.getElementById('colToggleBar');

  let editMode = false;
  let overrides = loadOverrides();
  let visibleCols = loadVisibleCols();

  function loadVisibleCols(){
    try {
      const raw = localStorage.getItem(COLS_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch(e){ /* fall through to defaults */ }
    return new Set(DEFAULT_VISIBLE_KEYS);
  }

  function saveVisibleCols(){
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(Array.from(visibleCols))); } catch(e){ /* storage unavailable — choice stays in-memory for this view */ }
  }

  function isColVisible(col){
    return col.alwaysVisible || visibleCols.has(col.key);
  }

  function loadOverrides(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch(e){ return {}; }
  }

  function saveOverrides(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch(e){ /* storage unavailable — edits stay in-memory for this view */ }
  }

  function valueFor(rowIndex, key){
    const cellKey = rowIndex + ':' + key;
    return Object.prototype.hasOwnProperty.call(overrides, cellKey) ? overrides[cellKey] : DEFAULT_ROWS[rowIndex][key];
  }

  function setValue(rowIndex, key, value){
    const cellKey = rowIndex + ':' + key;
    const defaultValue = DEFAULT_ROWS[rowIndex][key];
    if (value === defaultValue) delete overrides[cellKey];
    else overrides[cellKey] = value;
    saveOverrides();
    updateResetVisibility();
  }

  function updateResetVisibility(){
    resetBtn.classList.toggle('is-hidden', Object.keys(overrides).length === 0);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Renders "40(18 TTK)" as 40<span class="red">(18 TTK)</span>
  function formatDisplay(text, col){
    const safe = escapeHtml(text);
    if (!safe) return '<span class="cell-empty">&ndash;</span>';
    if (col.fullRed) return `<span class="red">${safe}</span>`;
    if (col.redParen) return safe.replace(/(\(.*?\))/, '<span class="red">$1</span>');
    return safe;
  }

  function renderColumnToggles(){
    const toggleable = COLUMNS.filter(c => !c.alwaysVisible);

    let html = '<div class="col-toggle-row">';
    toggleable.forEach(col => {
      const active = visibleCols.has(col.key);
      html += `<button type="button" class="col-chip${active ? ' is-active' : ''}" data-key="${col.key}" aria-pressed="${active}">${col.label}</button>`;
    });
    html += '</div>';
    html += '<div class="col-toggle-actions">' +
      '<button type="button" id="colsShowAll" class="text-link">Show all</button>' +
      '<span class="dot">&middot;</span>' +
      '<button type="button" id="colsReset" class="text-link">Reset to default</button>' +
      '</div>';

    colToggleBar.innerHTML = html;

    colToggleBar.querySelectorAll('.col-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (visibleCols.has(key)) visibleCols.delete(key);
        else visibleCols.add(key);
        saveVisibleCols();
        renderColumnToggles();
        render();
      });
    });
    document.getElementById('colsShowAll').addEventListener('click', () => {
      visibleCols = new Set(COLUMNS.map(c => c.key));
      saveVisibleCols();
      renderColumnToggles();
      render();
    });
    document.getElementById('colsReset').addEventListener('click', () => {
      visibleCols = new Set(DEFAULT_VISIBLE_KEYS);
      saveVisibleCols();
      renderColumnToggles();
      render();
    });
  }

  function render(){
    const groups = [];
    DEFAULT_ROWS.forEach((row, i) => {
      const last = groups[groups.length - 1];
      if (last && last.name === row.group) last.rows.push(i);
      else groups.push({ name: row.group, rows: [i] });
    });

    const cols = COLUMNS.filter(isColVisible);

    let head = '<thead><tr><th class="col-group" scope="col"><span>Leg</span></th>';
    cols.forEach(col => {
      head += `<th class="${col.sticky ? 'col-sticky' : ''}" scope="col">${col.label}</th>`;
    });
    head += '</tr></thead>';

    let body = '<tbody>';
    groups.forEach(g => {
      g.rows.forEach((rowIndex, i) => {
        body += `<tr class="group-${g.name.toLowerCase()}">`;
        if (i === 0) {
          body += `<td class="col-group" rowspan="${g.rows.length}"><span>${g.name}</span></td>`;
        }
        cols.forEach(col => {
          const value = valueFor(rowIndex, col.key);
          const stickyClass = col.sticky ? ' col-sticky' : '';
          const swatch = col.key === 'tws' ? `style="background:${DEFAULT_ROWS[rowIndex].color}"` : '';
          if (editMode) {
            body += `<td class="cell-edit${stickyClass}" ${swatch}><input type="text" inputmode="text" class="cell-input" data-row="${rowIndex}" data-key="${col.key}" value="${escapeHtml(value)}" aria-label="${col.label}, TWS ${DEFAULT_ROWS[rowIndex].tws}" /></td>`;
          } else {
            body += `<td class="${stickyClass}" ${swatch}>${formatDisplay(value, col)}</td>`;
          }
        });
        body += '</tr>';
      });
    });
    body += '</tbody>';

    tableEl.innerHTML = head + body;

    if (editMode) {
      tableEl.querySelectorAll('.cell-input').forEach(input => {
        input.addEventListener('input', () => {
          setValue(Number(input.dataset.row), input.dataset.key, input.value);
        });
      });
    }
  }

  editBtn.addEventListener('click', () => {
    editMode = !editMode;
    editBtn.textContent = editMode ? 'Done' : 'Edit';
    editBtn.classList.toggle('is-active', editMode);
    editHint.classList.toggle('is-hidden', !editMode);
    render();
  });

  resetBtn.addEventListener('click', () => {
    if (!window.confirm('Reset every value in this table back to the original reference numbers?')) return;
    overrides = {};
    saveOverrides();
    updateResetVisibility();
    render();
  });

  updateResetVisibility();
  renderColumnToggles();
  render();
})();
