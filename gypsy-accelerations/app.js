(() => {
  const STORAGE_KEY = 'seagull-gypsy-accel-v1';
  const START_ROWS = 10;

  // Plain data-entry log: every cell is always editable (no separate Edit
  // mode), rows start blank and are filled in on the boat.
  const COLUMNS = [
    { key:'tws',         label:'TWS',          inputmode:'decimal' },
    { key:'minBsp',       label:'Min BSP',      inputmode:'decimal' },
    { key:'buildAngle',   label:'Build Angle',  inputmode:'decimal' },
    { key:'chargeSpeed',  label:'Charge Speed', inputmode:'decimal' },
    { key:'chargeTime',   label:'Charge Time',  inputmode:'text' },
    { key:'notes',        label:'Other Notes',  inputmode:'text', wide:true },
  ];

  const tableEl = document.getElementById('gypsyTable');
  const addRowBtn = document.getElementById('addRowBtn');
  const resetBtn = document.getElementById('resetBtn');

  let rows = loadRows();

  function blankRow(){
    const row = {};
    COLUMNS.forEach(c => { row[c.key] = ''; });
    return row;
  }

  function defaultRows(){
    return Array.from({ length: START_ROWS }, blankRow);
  }

  function loadRows(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch(e){ /* fall through to defaults */ }
    return defaultRows();
  }

  function saveRows(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)); } catch(e){ /* storage unavailable — data stays in-memory for this view */ }
  }

  function isDefaultState(){
    return rows.length === START_ROWS && rows.every(row => COLUMNS.every(c => !row[c.key]));
  }

  function updateResetVisibility(){
    resetBtn.classList.toggle('is-hidden', isDefaultState());
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function render(focusRow){
    let head = '<thead><tr><th class="col-num" scope="col">#</th>';
    COLUMNS.forEach(col => {
      head += `<th class="${col.wide ? 'col-wide' : ''}" scope="col">${col.label}</th>`;
    });
    head += '<th class="col-remove" scope="col"><span class="sr-only">Remove row</span></th></tr></thead>';

    let body = '<tbody>';
    rows.forEach((row, rowIndex) => {
      body += `<tr>`;
      body += `<td class="col-num">${rowIndex + 1}</td>`;
      COLUMNS.forEach(col => {
        body += `<td class="cell-edit${col.wide ? ' col-wide' : ''}"><input type="text" inputmode="${col.inputmode}" class="cell-input" data-row="${rowIndex}" data-key="${col.key}" value="${escapeHtml(row[col.key])}" aria-label="${col.label}, row ${rowIndex + 1}" /></td>`;
      });
      body += `<td class="col-remove"><button type="button" class="row-remove" data-row="${rowIndex}" aria-label="Remove row ${rowIndex + 1}">&times;</button></td>`;
      body += '</tr>';
    });
    body += '</tbody>';

    tableEl.innerHTML = head + body;

    tableEl.querySelectorAll('.cell-input').forEach(input => {
      input.addEventListener('input', () => {
        rows[Number(input.dataset.row)][input.dataset.key] = input.value;
        saveRows();
        updateResetVisibility();
      });
    });

    tableEl.querySelectorAll('.row-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.row);
        const row = rows[idx];
        const hasData = COLUMNS.some(c => row[c.key]);
        if (hasData && !window.confirm('Remove this row? Its data will be lost.')) return;
        rows.splice(idx, 1);
        saveRows();
        updateResetVisibility();
        render();
      });
    });

    if (focusRow != null) {
      const target = tableEl.querySelector(`.cell-input[data-row="${focusRow}"][data-key="${COLUMNS[0].key}"]`);
      if (target) target.focus();
    }
  }

  addRowBtn.addEventListener('click', () => {
    rows.push(blankRow());
    saveRows();
    updateResetVisibility();
    render(rows.length - 1);
    addRowBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  resetBtn.addEventListener('click', () => {
    if (!window.confirm('Clear the table back to 10 blank rows?')) return;
    rows = defaultRows();
    saveRows();
    updateResetVisibility();
    render();
  });

  updateResetVisibility();
  render();
})();
