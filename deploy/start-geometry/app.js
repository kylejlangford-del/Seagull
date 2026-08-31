(() => {
  const SPEED_TABLE = [[7,25.8],[8,27.5],[9,29.0],[10,30.5],[11,31.8],[12,32.9],[13,34.0],[14,34.9],[15,35.7],[16,36.3],[17,36.9]];
  const KNOT_TO_MS = 0.514444;
  const NM_TO_M = 1852;
  const DEFAULT_LEFT_GAP_M = 485;
  const DEFAULT_RIGHT_GAP_M = 678;
  const DEFAULT_LINE_LENGTH_M = 0.24 * NM_TO_M;
  const DEFAULT_COURSE_WIDTH_M = DEFAULT_LEFT_GAP_M + DEFAULT_LINE_LENGTH_M + DEFAULT_RIGHT_GAP_M;
  const LEFT_GAP_SHARE = DEFAULT_LEFT_GAP_M / (DEFAULT_LEFT_GAP_M + DEFAULT_RIGHT_GAP_M);
  const RIGHT_GAP_SHARE = 1 - LEFT_GAP_SHARE;

  const defaults = { tws: 13, manualSpeed: 34, courseWidthM: DEFAULT_COURSE_WIDTH_M, lineLengthM: DEFAULT_LINE_LENGTH_M, mode: '90', unit: 'm' };
  let mode = defaults.mode;
  let unit = defaults.unit;

  const ids = ['tws','manualSpeed','courseWidth','courseWidthUnit','courseWidthMeta','lineDistance','lineDistanceUnit','lineDistanceMeta','validation','boatSpeed','speedLabel','speedMeta','lineTime','stbdTime','portTime','lineMeta','stbdMeta','portMeta','stbdDistance','portDistance','visualLine','visualPort','visualStbd','visualPortTime','visualStbdTime','startLineVisual','courseArrow','resetBtn','tab90','tab2board','twsField','manualSpeedField','unitM','unitNm','referenceTable'];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

  function finiteNumber(node, fallback = 0){ const v = Number(node.value); return Number.isFinite(v) ? v : fallback; }
  function toMetres(v){ return unit === 'nm' ? v * NM_TO_M : v; }
  function fromMetres(m){ return unit === 'nm' ? m / NM_TO_M : m; }
  function unitLabel(){ return unit === 'nm' ? 'NM' : 'm'; }
  function displayDecimals(m){ return unit === 'nm' ? 3 : (Math.abs(m) < 100 ? 1 : 1); }
  function formatInputValue(m){ return unit === 'nm' ? (m / NM_TO_M).toFixed(3) : m.toFixed(1); }
  function formatDistance(m, compact=false){
    if (!Number.isFinite(m) || m < 0) return '—';
    if (unit === 'nm') return `${(m/NM_TO_M).toFixed(compact ? 3 : 3)} NM`;
    return `${m.toFixed(compact ? 0 : 1)} m`;
  }
  function formatSeconds(s){ return Number.isFinite(s) && s >= 0 ? `${s.toFixed(1)} s` : '—'; }

  function interpolateSpeed(tws){
    if (tws <= SPEED_TABLE[0][0]) return SPEED_TABLE[0][1];
    if (tws >= SPEED_TABLE.at(-1)[0]) return SPEED_TABLE.at(-1)[1];
    for(let i=0;i<SPEED_TABLE.length-1;i++){
      const [x0,y0]=SPEED_TABLE[i], [x1,y1]=SPEED_TABLE[i+1];
      if(tws>=x0 && tws<=x1){ const f=(tws-x0)/(x1-x0); return y0+f*(y1-y0); }
    }
    return SPEED_TABLE[0][1];
  }

  function boundaryGeometry(courseWidthM,lineLengthM){
    const availableGap = courseWidthM - lineLengthM;
    return {
      portGapM: availableGap * LEFT_GAP_SHARE,
      stbdGapM: availableGap * RIGHT_GAP_SHARE
    };
  }

  function captureDistancesInMetres(){
    return {
      courseWidthM: Math.max(0, toMetres(finiteNumber(el.courseWidth, fromMetres(defaults.courseWidthM)))),
      lineLengthM: Math.max(0, toMetres(finiteNumber(el.lineDistance, fromMetres(defaults.lineLengthM))))
    };
  }

  function setUnit(nextUnit){
    if(nextUnit === unit) return;
    const current = captureDistancesInMetres();
    unit = nextUnit;
    el.courseWidth.value = formatInputValue(current.courseWidthM);
    el.lineDistance.value = formatInputValue(current.lineLengthM);
    el.courseWidthUnit.textContent = unitLabel();
    el.lineDistanceUnit.textContent = unitLabel();
    el.courseWidth.step = unit === 'nm' ? '0.001' : '0.1';
    el.lineDistance.step = unit === 'nm' ? '0.001' : '0.1';
    el.unitM.classList.toggle('is-active',unit==='m');
    el.unitNm.classList.toggle('is-active',unit==='nm');
    update();
  }

  function setMode(nextMode){
    mode = nextMode;
    const is90 = mode === '90';
    el.tab90.classList.toggle('is-active',is90); el.tab90.setAttribute('aria-selected',String(is90));
    el.tab2board.classList.toggle('is-active',!is90); el.tab2board.setAttribute('aria-selected',String(!is90));
    el.twsField.classList.toggle('is-hidden',!is90);
    el.manualSpeedField.classList.toggle('is-hidden',is90);
    el.referenceTable.classList.toggle('is-hidden',!is90);
    el.speedLabel.textContent = is90 ? 'Reference boat speed' : 'Manual boat speed';
    el.speedMeta.textContent = is90 ? '@ 90° TWA' : '2 Board';
    el.courseArrow.textContent = is90 ? '90° TWA reference speed' : '2 Board manual speed';
    update();
  }

  function updateVisual(portGap,line,stbdGap){
    const total=portGap+line+stbdGap;
    if(!(total>0)||portGap<0||stbdGap<0){ el.startLineVisual.style.left='35%'; el.startLineVisual.style.width='30%'; return; }
    const innerLeft=13, innerWidth=74;
    const leftPct=innerLeft+innerWidth*(portGap/total);
    const widthPct=innerWidth*(line/total);
    el.startLineVisual.style.left=`${leftPct}%`;
    el.startLineVisual.style.width=`${Math.max(0.5,widthPct)}%`;
  }

  function update(){
    const tws=finiteNumber(el.tws,defaults.tws);
    const manualSpeed=Math.max(0,finiteNumber(el.manualSpeed,defaults.manualSpeed));
    const courseWidthM=Math.max(0,toMetres(finiteNumber(el.courseWidth,fromMetres(defaults.courseWidthM))));
    const lineLengthM=Math.max(0,toMetres(finiteNumber(el.lineDistance,fromMetres(defaults.lineLengthM))));
    const geometry=boundaryGeometry(courseWidthM,lineLengthM);
    const messages=[];
    if(mode==='90'&&(tws<7||tws>17)) messages.push('The 90° TWA reference table covers 7–17 kn TWS; outside that range the nearest endpoint speed is used.');
    if(mode==='2board'&&manualSpeed<=0) messages.push('Enter a boat speed greater than 0 kn.');
    if(geometry.stbdGapM<0||geometry.portGapM<0) messages.push('The start line is longer than the course width.');

    const validGeometry=geometry.stbdGapM>=0&&geometry.portGapM>=0;
    const speedKn=mode==='90'?interpolateSpeed(tws):manualSpeed;
    const speedMs=speedKn*KNOT_TO_MS;
    const canTime=speedMs>0;
    const lineS=canTime?lineLengthM/speedMs:NaN;
    const stbdS=canTime&&validGeometry?geometry.stbdGapM/speedMs:NaN;
    const portS=canTime&&validGeometry?geometry.portGapM/speedMs:NaN;

    el.validation.textContent=messages.join(' ');
    el.courseWidthMeta.textContent=`${courseWidthM.toFixed(1)} m = ${(courseWidthM/NM_TO_M).toFixed(3)} NM`;
    el.lineDistanceMeta.textContent=`${lineLengthM.toFixed(1)} m = ${(lineLengthM/NM_TO_M).toFixed(3)} NM`;
    el.boatSpeed.textContent=`${speedKn.toFixed(1)} kn`;
    el.lineTime.textContent=formatSeconds(lineS); el.stbdTime.textContent=formatSeconds(stbdS); el.portTime.textContent=formatSeconds(portS);
    el.lineMeta.textContent=`${formatDistance(lineLengthM)} @ ${speedKn.toFixed(1)} kn`;
    el.stbdMeta.textContent=validGeometry?`${formatDistance(geometry.stbdGapM)} from line end`:'Invalid geometry';
    el.portMeta.textContent=validGeometry?`${formatDistance(geometry.portGapM)} from line end`:'Invalid geometry';
    el.stbdDistance.textContent=formatDistance(geometry.stbdGapM); el.portDistance.textContent=formatDistance(geometry.portGapM);
    el.visualLine.textContent=`${formatDistance(lineLengthM,true)} start line`;
    el.visualPort.textContent=formatDistance(geometry.portGapM,true); el.visualStbd.textContent=formatDistance(geometry.stbdGapM,true);
    el.visualPortTime.textContent=formatSeconds(portS); el.visualStbdTime.textContent=formatSeconds(stbdS);
    updateVisual(geometry.portGapM,lineLengthM,geometry.stbdGapM);
  }

  ['tws','manualSpeed','courseWidth','lineDistance'].forEach(id=>el[id].addEventListener('input',update));
  el.tab90.addEventListener('click',()=>setMode('90')); el.tab2board.addEventListener('click',()=>setMode('2board'));
  el.unitM.addEventListener('click',()=>setUnit('m')); el.unitNm.addEventListener('click',()=>setUnit('nm'));
  el.resetBtn.addEventListener('click',()=>{
    mode=defaults.mode; unit=defaults.unit;
    el.tws.value=defaults.tws; el.manualSpeed.value=defaults.manualSpeed;
    el.courseWidth.value=defaults.courseWidthM.toFixed(1); el.lineDistance.value=defaults.lineLengthM.toFixed(1);
    el.courseWidthUnit.textContent='m'; el.lineDistanceUnit.textContent='m'; el.courseWidth.step='0.1'; el.lineDistance.step='0.1';
    el.unitM.classList.add('is-active'); el.unitNm.classList.remove('is-active');
    setMode('90');
  });

  setMode('90');
})();
