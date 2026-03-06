import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { PieChart, Pie, Cell as RCell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

/* ─── Export / Import Utilities (pure JS — no external deps) ─── */
function dlFile(name,content,mime,ext){
  var blob=new Blob([content],{type:mime});
  var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name+ext;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);
}
function csvEsc(v){var s=String(v==null?"":v);return s.includes(",")||s.includes('"')||s.includes("\n")?'"'+s.replace(/"/g,'""')+'"':s;}
function dlSheets(name,sheets){
  var csv="\uFEFF"+sheets.map(function(sh){return "\u2500\u2500 "+sh[0]+" \u2500\u2500\n"+sh[1].map(function(r){return r.map(csvEsc).join(",");}).join("\n");}).join("\n\n");
  dlFile(name,csv,"text/csv;charset=utf-8;",".csv");
}

var EXP_COL_MAP={"task":"Name","owner":"Person","status":"Status","priority":"Priority","tlStart":"Timeline Start","tlEnd":"Timeline End","tags":"Labels","notes":"Text","weeklyUpdate":"Updates","completionDate":"Date","completionStatus":"Completion Status","dependentOn":"Dependencies","plannedEffort":"Planned","effortSpent":"Spent","timetracked":"Time Tracking"};
var EXP_MAIN_MAP={"task":"Name","owner":"Person","status":"Status","priority":"Priority","tltype":"Timeline Type","customer":"Group","team":"Team","progress":"Progress","weeklyUpdate":"Updates"};

/* Monday.com format: single CSV with "Group" column, timeline as "Start - End" range */
function exportBoardToExcel(board){
  var cm=board.isMain?EXP_MAIN_MAP:EXP_COL_MAP;
  var headers=["Group/Section"].concat(Object.values(cm));var keys=Object.keys(cm);
  var allRows=[];
  board.groups.forEach(function(g){
    g.rows.forEach(function(r){
      var row=[g.name||"Group"].concat(keys.map(function(k){
        if(k==="tags")return (r.tags||[]).join(", ");
        if(k==="progress")return (r.projectProgress||0)+"%";
        if(k==="tlStart"&&r.tlStart&&r.tlEnd)return r.tlStart+" - "+r.tlEnd;
        if(k==="tlEnd"&&r.tlStart)return "";
        return r[k]!=null?String(r[k]):"";
      }));
      allRows.push(row);
    });
  });
  /* Remove empty Timeline End column if we merged into Timeline Start */
  if(!board.isMain){
    var endIdx=headers.indexOf("Timeline End");
    if(endIdx>-1){headers.splice(endIdx,1);allRows.forEach(function(r){r.splice(endIdx,1);});headers[headers.indexOf("Timeline Start")]="Timeline";}
  }
  var csv="\uFEFF"+[headers].concat(allRows).map(function(r){return r.map(csvEsc).join(",");}).join("\n");
  dlFile((board.name||"board")+"_export",csv,"text/csv;charset=utf-8;",".csv");
}

function exportDashboardToExcel(boards){
  var tb=boards.filter(function(b){return !b.isMain&&!b.isDashboard&&!b.isSummary;});
  var allR=tb.flatMap(function(b){return b.groups.flatMap(function(g){return g.rows.map(function(r){return Object.assign({},r,{_board:b.name});});});});
  var sm={};allR.forEach(function(r){var s=r.status||"Not Started";sm[s]=(sm[s]||0)+1;});
  var pm={};allR.forEach(function(r){var p=r.priority||"No Priority";pm[p]=(pm[p]||0)+1;});
  var om={};allR.forEach(function(r){var o=r.owner||"Unassigned";om[o]=(om[o]||0)+1;});
  var bp=tb.map(function(b){var rows=b.groups.flatMap(function(g){return g.rows;});var t=rows.length,d=rows.filter(function(r){return r.status==="Done";}).length;return [b.name,t,d,t?Math.round(d/t*100)+"%":"0%"];});
  dlSheets("Dashboard_Export",[
    ["Status Breakdown",[["Status","Count"]].concat(Object.entries(sm))],
    ["Priority Breakdown",[["Priority","Count"]].concat(Object.entries(pm))],
    ["Workload",[["Owner","Tasks"]].concat(Object.entries(om))],
    ["Board Progress",[["Board","Total","Done","Progress"]].concat(bp)],
    ["All Items",[["Task","Board","Owner","Status","Priority","Start","End"]].concat(allR.map(function(r){return [r.task,r._board,r.owner,r.status,r.priority,r.tlStart,r.tlEnd];}))],
  ]);
}

function exportSummaryToExcel(boards,srcId){
  var tb=boards.filter(function(b){return !b.isMain&&!b.isDashboard&&!b.isSummary;});
  var srcRows;
  if(srcId==="all"){srcRows=tb.flatMap(function(b){return b.groups.flatMap(function(g){return g.rows.map(function(r){return Object.assign({},r,{_board:b.name});});});});}
  else{var sb=boards.find(function(b){return b.id===srcId;})||{groups:[]};srcRows=sb.groups.flatMap(function(g){return g.rows.map(function(r){return Object.assign({},r,{_board:sb.name||""});});});}
  var hdr=["Task","Board","Owner","Status","Priority","End Date","Notes"];
  var toRow=function(r){return [r.task,r._board,r.owner,r.status,r.priority,r.tlEnd,r.notes];};
  var blocked=srcRows.filter(function(r){var t=((r.task||"")+" "+(r.notes||"")).toLowerCase();return r.status==="Stuck"||t.includes("block")||t.includes("approv")||t.includes("waiting");});
  var upcoming=srcRows.filter(function(r){return !blocked.find(function(x){return x.id===r.id;})&&r.status!=="Done"&&(isOverdue(r)||(r.tlEnd&&daysDiff(r.tlEnd)<=7&&daysDiff(r.tlEnd)>=0));});
  var active=srcRows.filter(function(r){return r.status!=="Done"&&!blocked.find(function(x){return x.id===r.id;})&&!upcoming.find(function(x){return x.id===r.id;});});
  var done=srcRows.filter(function(r){return r.status==="Done";});
  dlSheets("Executive_Summary",[
    ["Blockers",[hdr].concat(blocked.map(toRow))],
    ["Deadlines",[hdr].concat(upcoming.map(toRow))],
    ["Active Work",[hdr].concat(active.map(toRow))],
    ["Done",[hdr].concat(done.map(toRow))],
  ]);
}

function parseCSVText(text){
  var rows=[];var cur=[];var buf="";var inQ=false;
  for(var i=0;i<text.length;i++){
    var c=text[i];
    if(inQ){if(c==='"'&&text[i+1]==='"'){buf+='"';i++;}else if(c==='"'){inQ=false;}else{buf+=c;}}
    else{if(c==='"'){inQ=true;}else if(c===","){cur.push(buf);buf="";}else if(c==="\n"||c==="\r"){if(c==="\r"&&text[i+1]==="\n")i++;cur.push(buf);buf="";if(cur.some(function(x){return x;}))rows.push(cur);cur=[];}else{buf+=c;}}
  }
  cur.push(buf);if(cur.some(function(x){return x;}))rows.push(cur);
  return rows;
}

function parseImportFile(file,cb){
  var reader=new FileReader();
  reader.onload=function(ev){
    try{
      var text=ev.target.result;
      var lines=parseCSVText(text);
      if(lines.length<2){cb(null,"File is empty or has no data rows");return;}
      var hdr=lines[0];var hdrMap={};
      hdr.forEach(function(h,idx){
        var hl=(h||"").toLowerCase().trim().replace(/['"]/g,"");
        /* Monday.com column name mappings */
        if(hl==="name"||hl==="item"||hl.includes("task")||hl.includes("title")||hl==="subitems")hdrMap.task=idx;
        else if(hl==="person"||hl==="owner"||hl==="assigned"||hl.includes("assignee")||hl==="pm"||hl==="people")hdrMap.owner=idx;
        else if(hl==="status"||hl==="stage")hdrMap.status=idx;
        else if(hl==="priority"||hl==="urgency")hdrMap.priority=idx;
        else if(hl==="timeline"||hl==="date"||hl.includes("start")){if(!hdrMap.tlStart)hdrMap.tlStart=idx;}
        else if(hl.includes("end")||hl.includes("due")||hl.includes("deadline")||hl==="timeline end")hdrMap.tlEnd=idx;
        else if(hl.includes("tag")||hl==="labels"||hl==="label")hdrMap.tags=idx;
        else if(hl.includes("note")||hl.includes("description")||hl.includes("comment")||hl==="text"||hl==="update"||hl==="updates")hdrMap.notes=idx;
        else if(hl==="group"||hl==="group/section"||hl==="section")hdrMap._group=idx;
      });
      if(hdrMap.task==null)hdrMap.task=0;
      /* Monday.com timeline is often "2026-01-05 - 2026-01-12" in one cell */
      var parseTL=function(v){if(!v)return["",""];var m=v.match(/(\d{4}[-/]\d{2}[-/]\d{2})\s*[-–]\s*(\d{4}[-/]\d{2}[-/]\d{2})/);if(m)return[m[1].replace(/\//g,"-"),m[2].replace(/\//g,"-")];return[v.replace(/\//g,"-"),""];};
      /* Monday.com statuses map */
      var normStatus=function(s){if(!s)return"Not Started";var l=s.toLowerCase();if(l.includes("done")||l.includes("complete"))return"Done";if(l.includes("stuck")||l.includes("block"))return"Stuck";if(l.includes("progress")||l.includes("working"))return"In Progress";return s;};
      var groupMap={};
      var rows=lines.slice(1).filter(function(l){return l.length>0&&l[hdrMap.task];}).map(function(l){
        var tl=hdrMap.tlStart!=null?parseTL(l[hdrMap.tlStart]):["",""];
        var gName=hdrMap._group!=null?(l[hdrMap._group]||"Imported"):"Imported";
        if(!groupMap[gName])groupMap[gName]=[];
        var row={id:"id_"+Math.random().toString(36).slice(2,9),task:l[hdrMap.task]||"",owner:hdrMap.owner!=null?(l[hdrMap.owner]||"").replace(/['"]/g,""):"",status:normStatus(hdrMap.status!=null?l[hdrMap.status]:""),priority:hdrMap.priority!=null?l[hdrMap.priority]||"No Priority":"No Priority",tlStart:hdrMap.tlStart!=null?tl[0]:"",tlEnd:hdrMap.tlEnd!=null?(l[hdrMap.tlEnd]||"").replace(/\//g,"-"):tl[1],tags:hdrMap.tags!=null?(l[hdrMap.tags]||"").split(/[,;]/).map(function(t){return t.trim();}).filter(Boolean):[],notes:hdrMap.notes!=null?l[hdrMap.notes]||"":"",timetracked:0,checked:false,updates:[],subitems:[],weeklyStatus:"",weeklyUpdate:"",completionDate:"",completionStatus:"-",dependentOn:"",plannedEffort:"",effortSpent:""};
        groupMap[gName].push(row);
        return row;
      });
      if(!rows.length){cb(null,"No data rows found");return;}
      var groups=Object.entries(groupMap).map(function(e,i){return{id:"id_"+Math.random().toString(36).slice(2,9),name:e[0],color:["#579bfc","#00c875","#fdab3d","#e2445c","#a25ddc"][i%5],collapsed:false,rows:e[1]};});
      cb(groups);
    }catch(err){cb(null,err.message);}
  };
  reader.readAsText(file);
}



const uid=()=>"id_"+Math.random().toString(36).slice(2,9);

/* ─── SHARED HELPERS ─── */
const useOutsideClick=(ref,onClose,active=true)=>{useEffect(()=>{if(!active)return;const h=e=>{if(ref.current&&!ref.current.contains(e.target))onClose();};document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);},[ref,onClose,active]);};
const Toggle=({on,onToggle})=>(<div onClick={onToggle} style={{width:36,height:20,borderRadius:10,background:on?"#00c875":"#ccc",cursor:"pointer",position:"relative",flexShrink:0}}><div style={{width:16,height:16,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:on?18:2,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.2)"}}/></div>);
const Initials=(name)=>name?name.split(" ").map(n=>n[0]).join("").slice(0,2).toUpperCase():"?";

const ts=()=>new Date().toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
const CL=["#579bfc","#00c875","#a25ddc","#fdab3d","#e2445c","#037f4c","#ff642e","#00d2d2","#bb3354","#175a63"];
const SC={"Done":"#00c875","Working on it":"#fdab3d","Stuck":"#e2445c","Not Started":"#c4c4c4","Future steps":"#a25ddc","In Progress":"#0073ea","Waiting":"#7c5cfc","Review":"#037f4c"};
const PC={"Critical":"#333","High":"#e2445c","Medium":"#fdab3d","Low":"#579bfc","No Priority":"#c4c4c4"};
const COMP_SC={"Done On Time":"#00c875","Done Late":"#e2445c","In Progress":"#fdab3d","-":"#c4c4c4"};
const COMP_STATS=["Done On Time","Done Late","In Progress","-"];
const TL_TYPES=["Soft Date","Firm Date","TBD"];
const TL_TYPE_C={"Soft Date":"#fdab3d","Firm Date":"#e2445c","TBD":"#c4c4c4"};
const CUSTOMERS=["Infrastructure","Marketing","Engineering","HR","Finance","Legal"];
const CUST_C={"Infrastructure":"#00c875","Marketing":"#fdab3d","Engineering":"#579bfc","HR":"#a25ddc","Finance":"#ff642e","Legal":"#e2445c"};
const TEAMS=["Alpha","Beta","Gamma","Delta"];
const AVATAR_COLORS=["#6c5ce7","#0984e3","#00b894","#e17055","#d63031","#fdcb6e","#e84393","#00cec9","#636e72","#2d3436"];
const ROLES=["Admin","Member","Viewer"];
const ROLE_COLORS={"Admin":"#6c5ce7","Member":"#0984e3","Viewer":"#c4c4c4"};
const DEFAULT_TEAM=[
  {id:"u_1",name:"Alex M.",email:"alex@company.com",role:"Admin",color:"#6c5ce7",online:true,lastSeen:"Just now"},
  {id:"u_2",name:"Sarah K.",email:"sarah@company.com",role:"Member",color:"#0984e3",online:true,lastSeen:"Just now"},
  {id:"u_3",name:"Tom W.",email:"tom@company.com",role:"Member",color:"#00b894",online:false,lastSeen:"2h ago"},
  {id:"u_4",name:"James L.",email:"james@company.com",role:"Member",color:"#e17055",online:false,lastSeen:"1d ago"},
  {id:"u_5",name:"Nina R.",email:"nina@company.com",role:"Viewer",color:"#d63031",online:false,lastSeen:"3d ago"},
  {id:"u_6",name:"Chris D.",email:"chris@company.com",role:"Member",color:"#e84393",online:true,lastSeen:"Just now"},
  {id:"u_7",name:"Pat G.",email:"pat@company.com",role:"Viewer",color:"#00cec9",online:false,lastSeen:"5h ago"},
];
const MAIN_COLS=[
  {id:"task",name:"Project",type:"text",w:220},{id:"owner",name:"PM",type:"person",w:80},
  {id:"status",name:"Status",type:"status",w:120,synced:true},{id:"priority",name:"Priority",type:"priority",w:120},
  {id:"tltype",name:"Timeline Type",type:"tltype",w:120},{id:"customer",name:"Customer",type:"customer",w:120},
  {id:"team",name:"Team",type:"team",w:100},{id:"progress",name:"Progress",type:"progress",w:140},
  {id:"weeklyUpdate",name:"Weekly Update",type:"weeklyUpdate",w:220,synced:true},{id:"linkedBoard",name:"Linked Board",type:"linkedBoard",w:120},
];
const DCOLS=[
  {id:"task",name:"Task",type:"text",w:220},{id:"owner",name:"Owner",type:"person",w:80},{id:"updates",name:"Updates",type:"updates",w:55},
  {id:"status",name:"Status",type:"status",w:120},{id:"priority",name:"Priority",type:"priority",w:120},
  {id:"timeline",name:"Timeline",type:"timeline",w:180},{id:"duration",name:"Duration",type:"duration",w:90},
  {id:"tags",name:"Tags",type:"tags",w:90},{id:"timetracked",name:"Time Tracked",type:"timer",w:110},
];
const cloneCols=(c)=>c.map(x=>({...x}));
const PEOPLE=["Alex M.","Sarah K.","James L.","Nina R.","Tom W.","Chris D.","Pat G."];
const STATS=["Done","Working on it","Stuck","Not Started","Future steps","In Progress","Waiting","Review"];
const PRIS=["Critical","High","Medium","Low","No Priority"];
const TAGS=["Urgent","Bug","Feature","Review","Docs","Security","Infra","Migration"];
const DD_COLORS=["#579bfc","#00c875","#fdab3d","#e2445c","#a25ddc","#037f4c","#ff642e","#00d2d2","#bb3354","#c4c4c4"];
const mk=(d={})=>({id:uid(),task:"",owner:"",status:"Not Started",priority:"No Priority",tlStart:"",tlEnd:"",tags:[],timetracked:0,checked:false,updates:[],weeklyStatus:"",weeklyUpdate:"",completionDate:"",completionStatus:"-",dependentOn:"",plannedEffort:"",effortSpent:"",subitems:[],notes:"",...d});
const mkSub=(d={})=>({id:uid(),task:"",owner:"",status:"Not Started",checked:false,...d});
const mkU=(t,a="System")=>({id:uid(),text:t,author:a,time:ts()});

/* ─── BOARD SYNC ENGINE ─── */
function computeBoardStats(board){
  const all=board.groups.flatMap(g=>g.rows);const total=all.length;
  const done=all.filter(i=>i.status==="Done").length;
  const progress=total?Math.round((done/total)*100):0;
  const latestUpdate=all.filter(i=>i.weeklyUpdate||i.weeklyStatus).map(i=>i.weeklyUpdate||i.weeklyStatus).pop()||"";
  let derivedStatus="Not Started";
  if(done===total&&total>0)derivedStatus="Done";
  else if(done>0||all.some(i=>i.status==="In Progress"||i.status==="Working on it"))derivedStatus="In Progress";
  else if(all.some(i=>i.status==="Stuck"))derivedStatus="Stuck";
  return{progress,derivedStatus,latestUpdate};
}
function syncBoards(boards,changedBoardId,logSync){
  const changed=boards.find(b=>b.id===changedBoardId);
  if(!changed||changed.isMain)return boards;
  const stats=computeBoardStats(changed);
  let result=[...boards];
  /* sync to linkedMainBoardId (portfolio) */
  if(changed.linkedMainBoardId){
    result=result.map(b=>{
      if(b.id!==changed.linkedMainBoardId)return b;
      return{...b,groups:b.groups.map(g=>({...g,rows:g.rows.map(i=>{
        if(i.task!==changed.linkedMainItemName)return i;
        const upd={};
        if(i.status!==stats.derivedStatus){upd.status=stats.derivedStatus;if(logSync)logSync(b.id,"Sync","\""+i.task+"\" status → "+stats.derivedStatus,"#a25ddc","Auto-synced from "+changed.name);}
        if((i.projectProgress||0)!==stats.progress){upd.projectProgress=stats.progress;if(logSync)logSync(b.id,"Sync","\""+i.task+"\" progress → "+stats.progress+"%","#a25ddc","Auto-synced from "+changed.name);}
        if(stats.latestUpdate&&i.weeklyUpdate!==stats.latestUpdate){upd.weeklyUpdate=stats.latestUpdate;if(logSync)logSync(b.id,"Sync","\""+i.task+"\" weekly update synced","#a25ddc","Auto-synced from "+changed.name);}
        return Object.keys(upd).length?{...i,...upd}:i;
      })}))};
    });
  }
  /* sync to additional syncTargets */
  if(changed.syncTargets&&changed.syncTargets.length>0){
    changed.syncTargets.forEach(st=>{
      result=result.map(b=>{
        if(b.id!==st.boardId)return b;
        /* check if a row already exists for this synced board */
        let found=false;
        const updated={...b,groups:b.groups.map((g,gi)=>{
          return{...g,rows:g.rows.map(r=>{
            if(r._syncSourceId!==changed.id)return r;
            found=true;
            const upd={};
            if(r.status!==stats.derivedStatus)upd.status=stats.derivedStatus;
            if((r.projectProgress||0)!==stats.progress)upd.projectProgress=stats.progress;
            if(stats.latestUpdate&&r.weeklyUpdate!==stats.latestUpdate)upd.weeklyUpdate=stats.latestUpdate;
            if(Object.keys(upd).length){
              if(logSync)logSync(b.id,"Sync","\""+r.task+"\" synced from "+changed.name,"#a25ddc","Cross-board sync");
              return{...r,...upd};
            }
            return r;
          })};
        })};
        /* if no existing row found, create one in first group */
        if(!found&&updated.groups.length>0){
          const newRow=mk({task:changed.name,status:stats.derivedStatus,owner:changed.groups[0]?.rows[0]?.owner||"",weeklyUpdate:stats.latestUpdate,projectProgress:stats.progress,_syncSourceId:changed.id,_syncReadonly:true});
          updated.groups[0]={...updated.groups[0],rows:[...updated.groups[0].rows,newRow]};
          if(logSync)logSync(b.id,"Sync","Added \""+changed.name+"\" from cross-board sync","#a25ddc","Cross-board sync");
        }
        return updated;
      });
    });
  }
  return result;
}
const calcDur=(s,e,long)=>{if(!s||!e)return"";const d=Math.ceil((new Date(e)-new Date(s))/(864e5));return d>0?(long?(d===1?"1 day":d+" days"):d+"d"):"";};
const fmtTL=(s,e)=>{if(!s&&!e)return"";const f=d=>{const p=new Date(d);return p.toLocaleDateString("en-US",{month:"short",day:"numeric"});};if(s&&e){const ds=new Date(s),de=new Date(e);if(ds.getMonth()===de.getMonth()&&ds.getFullYear()===de.getFullYear())return f(s).split(" ")[0]+" "+ds.getDate()+" - "+de.getDate();return f(s)+" - "+f(e);}return f(s||e);};
const today=()=>new Date().toISOString().split("T")[0];
const isOverdue=(r)=>r.tlEnd&&r.status!=="Done"&&new Date(r.tlEnd)<new Date(today());

const BOARD_CATS=["ACTIVE","IN PROGRESS","COMPLETED","STALLED","ON HOLD"];
const CAT_ICONS={"ACTIVE":"🟢","IN PROGRESS":"🔵","COMPLETED":"✅","STALLED":"🟡","ON HOLD":"⏸️"};

const BOARD_TEMPLATES=[
  {name:"IT Project",icon:"💻",groups:[{name:"Backlog",color:"#c4c4c4"},{name:"Sprint",color:"#579bfc"},{name:"In Review",color:"#fdab3d"},{name:"Released",color:"#00c875"}]},
  {name:"Helpdesk Tracker",icon:"🎫",groups:[{name:"New Tickets",color:"#e2445c"},{name:"In Progress",color:"#579bfc"},{name:"Resolved",color:"#00c875"}]},
  {name:"Infrastructure",icon:"🔧",groups:[{name:"Planning",color:"#a25ddc"},{name:"Procurement",color:"#fdab3d"},{name:"Implementation",color:"#579bfc"},{name:"Monitoring",color:"#00c875"}]},
  {name:"Security Audit",icon:"🔒",groups:[{name:"Findings",color:"#e2445c"},{name:"Remediation",color:"#fdab3d"},{name:"Verified",color:"#00c875"}]},
  {name:"Blank Board",icon:"📋",groups:[{name:"Group 1",color:"#579bfc"}]},
  {name:"Dashboard",icon:"📊",isDashboard:true,groups:[]},
  {name:"Executive Summary",icon:"📑",isSummary:true,groups:[]},
];

const INIT_WS=[{id:"ws_it",name:"IT Operations",icon:"💻",owner:"u_admin",shared:[{userId:"u_2",access:"write"},{userId:"u_3",access:"read"}]},{id:"ws_sec",name:"Cybersecurity",icon:"🔒",owner:"u_admin",shared:[{userId:"u_2",access:"write"}]},{id:"ws_infra",name:"Infrastructure",icon:"🏗️",owner:"u_admin",shared:[]}];
const IBOARDS=[
  /* PORTFOLIO BOARD */
  {id:"b_portfolio",name:"IT Portfolio 2026",desc:"All active IT projects — status & progress auto-synced from linked boards",cat:"ACTIVE",wsId:"ws_it",icon:"📊",isMain:true,owner:"u_admin",shared:[],hist:[],columns:cloneCols(MAIN_COLS),groups:[
    {id:"g_ap",name:"Active Projects",color:"#6c5ce7",collapsed:false,rows:[
      {...mk({task:"M365 Tenant Migration",owner:"Alex M.",status:"In Progress",priority:"Critical",weeklyUpdate:"50 mailboxes migrated this week, 200 remaining. MX cutover scheduled Friday."}),timeline:"Firm Date",customer:"Infrastructure",team:"Alpha",projectProgress:55},
      {...mk({task:"Zero Trust Network Rollout",owner:"Sarah K.",status:"Working on it",priority:"High",weeklyUpdate:"Conditional access policies deployed to pilot group. MFA enforcement next week."}),timeline:"Firm Date",customer:"Engineering",team:"Beta",projectProgress:30},
      {...mk({task:"SCCM to Intune Migration",owner:"Tom W.",status:"In Progress",priority:"High",weeklyUpdate:"App packaging complete for 80% of apps. Co-management enabled."}),timeline:"Soft Date",customer:"Infrastructure",team:"Gamma",projectProgress:40},
      {...mk({task:"SOC Monitoring Platform",owner:"James L.",status:"Not Started",priority:"Medium",weeklyUpdate:""}),timeline:"Soft Date",customer:"Engineering",team:"Delta",projectProgress:0},
      {...mk({task:"DR Site Failover Testing",owner:"Chris D.",status:"Stuck",priority:"Critical",weeklyUpdate:"WAN circuit at DR site failed vendor SLA — escalated to account team"}),timeline:"Firm Date",customer:"Infrastructure",team:"Alpha",projectProgress:15},
    ]},
  ]},
  /* TASK BOARDS */
  {id:"b_m365",name:"M365 Tenant Migration",desc:"Full Microsoft 365 tenant migration — mail, Teams, SharePoint, OneDrive",cat:"ACTIVE",wsId:"ws_it",icon:"📧",isMain:false,linkedMainBoardId:"b_portfolio",linkedMainItemName:"M365 Tenant Migration",owner:"u_admin",shared:[{userId:"u_2",access:"write"},{userId:"u_3",access:"read"}],hist:[],columns:cloneCols(DCOLS),groups:[
    {id:"g_m1",name:"Pre-Migration",color:"#a25ddc",collapsed:false,rows:[
      mk({task:"Tenant-to-tenant trust config",owner:"Alex M.",status:"Done",priority:"Critical",tlStart:"2026-02-01",tlEnd:"2026-02-05",tags:["Infra"],updates:[mkU("Azure AD B2B trust established","Alex M."),mkU("Test mailbox migration successful","Sarah K.")]}),
      mk({task:"DNS pre-staging (TXT records)",owner:"Tom W.",status:"Done",priority:"High",tlStart:"2026-02-06",tlEnd:"2026-02-07",tags:["Infra"]}),
      mk({task:"License reconciliation audit",owner:"Nina R.",status:"Done",priority:"Medium",tlStart:"2026-02-03",tlEnd:"2026-02-10",tags:["Docs"]}),
      mk({task:"User communication plan",owner:"Pat G.",status:"Done",priority:"Medium",tlStart:"2026-02-08",tlEnd:"2026-02-12",tags:["Docs"],updates:[mkU("Email templates approved by comms team","Pat G.")]}),
    ]},
    {id:"g_m2",name:"Migration Waves",color:"#579bfc",collapsed:false,rows:[
      mk({task:"Wave 1 — IT Dept (50 users)",owner:"Alex M.",status:"Done",priority:"High",tlStart:"2026-02-17",tlEnd:"2026-02-19",tags:["Migration"],subitems:[mkSub({task:"Mailbox migration",status:"Done",owner:"Alex M."}),mkSub({task:"OneDrive sync",status:"Done",owner:"Tom W."}),mkSub({task:"Teams channels",status:"Done",owner:"Sarah K."})]}),
      mk({task:"Wave 2 — Finance & HR (80 users)",owner:"Sarah K.",status:"Done",priority:"High",tlStart:"2026-02-24",tlEnd:"2026-02-26",tags:["Migration"]}),
      mk({task:"Wave 3 — Sales & Marketing (120 users)",owner:"Alex M.",status:"In Progress",priority:"High",tlStart:"2026-03-03",tlEnd:"2026-03-07",tags:["Migration"],updates:[mkU("50 mailboxes complete, 70 remaining","Alex M."),mkU("3 shared mailboxes need manual fix","Tom W.")]}),
      mk({task:"Wave 4 — All remaining (200 users)",owner:"Tom W.",status:"Not Started",priority:"High",tlStart:"2026-03-10",tlEnd:"2026-03-14",tags:["Migration"]}),
      mk({task:"MX record cutover",owner:"Alex M.",status:"Not Started",priority:"Critical",tlStart:"2026-03-15",tlEnd:"2026-03-15",tags:["Infra","Urgent"]}),
    ]},
    {id:"g_m3",name:"Post-Migration",color:"#00c875",collapsed:true,rows:[
      mk({task:"Decommission old Exchange server",owner:"Tom W.",status:"Not Started",priority:"Medium",tlStart:"2026-03-17",tlEnd:"2026-03-21"}),
      mk({task:"Update MFA policies for new tenant",owner:"Sarah K.",status:"Not Started",priority:"High",tlStart:"2026-03-16",tlEnd:"2026-03-18",tags:["Security"]}),
      mk({task:"User training sessions (Teams)",owner:"Pat G.",status:"Not Started",priority:"Medium",tlStart:"2026-03-10",tlEnd:"2026-03-14"}),
    ]},
  ]},
  {id:"b_zerotrust",name:"Zero Trust Network",desc:"Zero Trust architecture rollout — Conditional Access, MFA, device compliance",cat:"ACTIVE",wsId:"ws_sec",icon:"🔐",isMain:false,linkedMainBoardId:"b_portfolio",linkedMainItemName:"Zero Trust Network Rollout",owner:"u_admin",shared:[],hist:[],columns:cloneCols(DCOLS),groups:[
    {id:"g_z1",name:"Identity & Access",color:"#e2445c",collapsed:false,rows:[
      mk({task:"Enforce MFA for all users",owner:"Sarah K.",status:"Done",priority:"Critical",tlStart:"2026-02-01",tlEnd:"2026-02-14",tags:["Security"],updates:[mkU("MFA enforced for admins and VIPs","Sarah K."),mkU("Full rollout complete — 99.2% adoption","Sarah K.")]}),
      mk({task:"Conditional Access — require compliant device",owner:"Sarah K.",status:"Working on it",priority:"High",tlStart:"2026-02-17",tlEnd:"2026-03-07",tags:["Security"],updates:[mkU("Pilot group of 50 users live, monitoring exceptions","Sarah K.")]}),
      mk({task:"Disable legacy authentication protocols",owner:"James L.",status:"Not Started",priority:"High",tlStart:"2026-03-10",tlEnd:"2026-03-14",tags:["Security"]}),
    ]},
    {id:"g_z2",name:"Network Segmentation",color:"#579bfc",collapsed:false,rows:[
      mk({task:"VLAN restructure — server segment",owner:"Tom W.",status:"Working on it",priority:"High",tlStart:"2026-03-01",tlEnd:"2026-03-10",tags:["Infra"]}),
      mk({task:"Micro-segmentation for PCI scope",owner:"Chris D.",status:"Not Started",priority:"Critical",tlStart:"2026-03-12",tlEnd:"2026-03-21",tags:["Security","Infra"]}),
    ]},
  ]},
  {id:"b_intune",name:"SCCM to Intune Migration",desc:"Migrate endpoint management from SCCM to Microsoft Intune",cat:"IN PROGRESS",wsId:"ws_it",icon:"📱",isMain:false,linkedMainBoardId:"b_portfolio",linkedMainItemName:"SCCM to Intune Migration",owner:"u_admin",shared:[{userId:"u_4",access:"write"}],hist:[],columns:cloneCols(DCOLS),groups:[
    {id:"g_i1",name:"App Packaging",color:"#fdab3d",collapsed:false,rows:[
      mk({task:"Package Chrome Enterprise (.intunewin)",owner:"Tom W.",status:"Done",priority:"Medium",tlStart:"2026-02-10",tlEnd:"2026-02-12",tags:["Feature"]}),
      mk({task:"Package Adobe Acrobat DC",owner:"Tom W.",status:"Done",priority:"Medium",tlStart:"2026-02-12",tlEnd:"2026-02-14"}),
      mk({task:"Package Zoom Workplace",owner:"Chris D.",status:"Done",priority:"Medium",tlStart:"2026-02-14",tlEnd:"2026-02-15"}),
      mk({task:"Package internal LOB apps (5 remaining)",owner:"Tom W.",status:"In Progress",priority:"High",tlStart:"2026-02-17",tlEnd:"2026-03-07",tags:["Feature"],updates:[mkU("3 of 8 LOB apps packaged — SAP connector problematic","Tom W.")]}),
    ]},
    {id:"g_i2",name:"Enrollment & Compliance",color:"#00c875",collapsed:false,rows:[
      mk({task:"Enable co-management in SCCM",owner:"Alex M.",status:"Done",priority:"Critical",tlStart:"2026-02-03",tlEnd:"2026-02-05"}),
      mk({task:"Compliance policies — BitLocker + AV",owner:"Sarah K.",status:"In Progress",priority:"High",tlStart:"2026-02-20",tlEnd:"2026-03-05",tags:["Security"]}),
      mk({task:"Autopilot profile for new devices",owner:"Tom W.",status:"Not Started",priority:"Medium",tlStart:"2026-03-10",tlEnd:"2026-03-14"}),
    ]},
  ]},
  {id:"b_dr",name:"DR Failover Testing",desc:"Annual disaster recovery validation — Azure Site Recovery",cat:"STALLED",wsId:"ws_infra",icon:"🔥",isMain:false,linkedMainBoardId:"b_portfolio",linkedMainItemName:"DR Site Failover Testing",owner:"u_admin",shared:[],hist:[],columns:cloneCols(DCOLS),groups:[
    {id:"g_d1",name:"Preparation",color:"#e2445c",collapsed:false,rows:[
      mk({task:"Validate ASR replication health",owner:"Chris D.",status:"Done",priority:"Critical",tlStart:"2026-02-15",tlEnd:"2026-02-18",tags:["Infra"]}),
      mk({task:"Update DR runbook",owner:"James L.",status:"Done",priority:"High",tlStart:"2026-02-18",tlEnd:"2026-02-21",tags:["Docs"]}),
      mk({task:"WAN circuit validation at DR site",owner:"Tom W.",status:"Stuck",priority:"Critical",tlStart:"2026-02-22",tlEnd:"2026-02-25",tags:["Infra","Urgent"],updates:[mkU("Circuit showing 40% packet loss — vendor escalated","Tom W."),mkU("Vendor ETA: 5 business days for tech dispatch","Chris D.")]}),
    ]},
    {id:"g_d2",name:"Failover Execution",color:"#579bfc",collapsed:true,rows:[
      mk({task:"Failover — Domain Controllers",owner:"Alex M.",status:"Not Started",priority:"Critical",tags:["Infra"]}),
      mk({task:"Failover — SQL cluster",owner:"James L.",status:"Not Started",priority:"Critical",tags:["Infra"]}),
      mk({task:"Failover — Web apps tier",owner:"Chris D.",status:"Not Started",priority:"High",tags:["Infra"]}),
      mk({task:"DNS failover test",owner:"Tom W.",status:"Not Started",priority:"High",tags:["Infra"]}),
      mk({task:"Executive sign-off & compliance report",owner:"Pat G.",status:"Not Started",priority:"Medium",tags:["Docs"]}),
    ]},
  ]},
  {id:"b_helpdesk",name:"Helpdesk Q1 Sprint",desc:"IT helpdesk tickets and recurring ops tasks",cat:"ACTIVE",wsId:"ws_it",icon:"🎫",isMain:false,owner:"u_admin",shared:[{userId:"u_2",access:"write"},{userId:"u_3",access:"write"},{userId:"u_6",access:"write"}],hist:[],columns:cloneCols(DCOLS),groups:[
    {id:"g_h1",name:"Open Tickets",color:"#e2445c",collapsed:false,rows:[
      mk({task:"TKT-4201 — VPN drops on macOS Sonoma",owner:"Chris D.",status:"Working on it",priority:"High",tags:["Bug"],updates:[mkU("Reproduced on 3 machines — GlobalProtect version issue","Chris D.")]}),
      mk({task:"TKT-4215 — Shared printer not mapping via GPO",owner:"Nina R.",status:"In Progress",priority:"Medium",tags:["Bug"]}),
      mk({task:"TKT-4220 — New hire onboarding — Priya S.",owner:"Pat G.",status:"In Progress",priority:"High",tags:["Feature"],subitems:[mkSub({task:"AD account creation",status:"Done",owner:"Pat G."}),mkSub({task:"Laptop imaging",status:"In Progress",owner:"Chris D."}),mkSub({task:"M365 license assignment",status:"Not Started",owner:"Nina R."})]}),
    ]},
    {id:"g_h2",name:"Resolved This Week",color:"#00c875",collapsed:true,rows:[
      mk({task:"TKT-4198 — Outlook search not indexing",owner:"Nina R.",status:"Done",priority:"Medium",completionDate:"2026-03-04",completionStatus:"Done On Time"}),
      mk({task:"TKT-4199 — Conference room display firmware",owner:"Chris D.",status:"Done",priority:"Low",completionDate:"2026-03-03",completionStatus:"Done On Time"}),
    ]},
  ]},
];

const DEF_AUTOS=[
  {id:"a1",enabled:true,trigger:"status_done",title:"Auto-complete date",label:"When Status → Done, set Completion Date to today",cat:"Status",popular:true},
  {id:"a2",enabled:true,trigger:"status_done_move",title:"Move done items",label:"When Status → Done, move item to last group",cat:"Status",popular:true},
  {id:"a3",enabled:false,trigger:"date_passed",title:"Overdue → Stuck",label:"When end date passes and not Done, set Status to Stuck",cat:"Date",popular:true},
];
const AUTO_RECIPES=[
  {id:"r1",cat:"Status",title:"When status changes to Done",desc:"Set completion date to today automatically",popular:true,trigger:"status_done"},
  {id:"r2",cat:"Status",title:"Move done items to group",desc:"When status → Done, move item to last group in board",popular:true,trigger:"status_done_move"},
  {id:"r3",cat:"Date",title:"Overdue → Stuck",desc:"When end date passes, change status to Stuck automatically",popular:true,trigger:"date_passed"},
  {id:"r4",cat:"Date",title:"Deadline reminder",desc:"When 3 days before due date, raise priority to High",popular:true,trigger:"deadline_reminder"},
  {id:"r5",cat:"Assignment",title:"Notify on assignment",desc:"When person is assigned, add an update noting the assignment",popular:true,trigger:"owner_set"},
  {id:"r6",cat:"Progress",title:"All subitems done → Done",desc:"When all subitems are Done, set parent status to Done",popular:true,trigger:"subitems_done"},
  {id:"r7",cat:"Status",title:"Auto-set priority on create",desc:"When new item created, set priority to Medium",popular:false,trigger:"item_created_priority"},
  {id:"r8",cat:"Status",title:"Stuck → alert + raise priority",desc:"When status changes to Stuck, add alert and raise priority if Low",popular:true,trigger:"status_stuck_notify"},
  {id:"r9",cat:"Date",title:"Set start date on progress",desc:"When status → In Progress, set start date to today if empty",popular:false,trigger:"status_progress_date"},
  {id:"r10",cat:"Progress",title:"Sync to portfolio",desc:"When status changes, update linked portfolio board (always on)",popular:true,trigger:"sync_main"},
  {id:"r11",cat:"Recurring",title:"Create weekly standup item",desc:"Creates a 'Weekly Standup' item in first group when enabled",popular:true,trigger:"recurring_weekly"},
  {id:"r12",cat:"Integration",title:"Log completion for digest",desc:"When status → Done, log completion timestamp for email digest",popular:false,trigger:"email_done"},
  {id:"r13",cat:"Status",title:"Not Started → In Progress on edit",desc:"When task name is edited and status is Not Started, change to In Progress",popular:false,trigger:"edit_start"},
  {id:"r14",cat:"Assignment",title:"Auto-assign to creator",desc:"When new item created, assign to current user",popular:false,trigger:"item_created_assign"},
  {id:"r15",cat:"Date",title:"Set due date on create (+7 days)",desc:"When new item created, set end date to 7 days from now",popular:false,trigger:"item_created_duedate"},
];

const NOTIFS=[
  {id:"n1",text:"DR Site WAN circuit is down — vendor escalated",type:"warning",time:"1 hour ago",read:false},
  {id:"n2",text:"Alex M. completed Wave 2 mailbox migration",type:"success",time:"3 hours ago",read:false},
  {id:"n3",text:"MFA enforcement hit 99.2% adoption",type:"success",time:"Yesterday",read:false},
  {id:"n4",text:"TKT-4201 VPN issue reproduced — GlobalProtect update needed",type:"update",time:"Yesterday",read:true},
  {id:"n5",text:"LOB app packaging delayed — SAP connector issue",type:"warning",time:"2 days ago",read:true},
];

/* Every return of JSX MUST use parentheses: return(...) not return <...
   to prevent the minifier from merging "return" and "React" into "returnReact" */

const DD=({anchorRef,open,onClose,children,w=200,pos:forcePos})=>{
  const [pos,setPos]=useState({top:0,left:0});const ref=useRef(null);
  useEffect(()=>{if(open&&forcePos){setPos(forcePos);}else if(open&&anchorRef?.current){const r=anchorRef.current.getBoundingClientRect();let l=r.left,t=r.bottom+4;if(l+w>window.innerWidth)l=window.innerWidth-w-8;if(t+320>window.innerHeight)t=Math.max(8,r.top-324);setPos({top:t,left:l});}},[open,anchorRef,w,forcePos]);
  useEffect(()=>{if(!open)return;const h=e=>{if(!ref.current?.contains(e.target)&&!anchorRef?.current?.contains(e.target))onClose();};document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);},[open,onClose,anchorRef]);
  if(!open) return (null);
  return (<div ref={ref} style={{position:"fixed",top:pos.top,left:pos.left,width:w,zIndex:99999,background:"#fff",border:"1px solid #e0e0e0",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,.15)",maxHeight:340,overflowY:"auto"}} onMouseDown={e=>e.stopPropagation()}>{children}</div>);
};
const EDD=({anchorRef,open,onClose,items,cmap,label,onSelect,oc})=>{
  const [a,sa]=useState(false);const [nv,snv]=useState("");
  return(<DD anchorRef={anchorRef} open={open} onClose={()=>{onClose();sa(false);}} w={210}><div style={{padding:6}}>
    <div style={{fontSize:11,color:"#666",padding:"4px 8px",fontWeight:600}}>{label}</div>
    {items.map((it,i)=>(<div key={i} onClick={()=>{onSelect(it);onClose();}} style={{display:"flex",alignItems:"center",padding:"5px 8px",borderRadius:4,cursor:"pointer",gap:8}} onMouseEnter={e=>e.currentTarget.style.background="#f5f5f5"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      {cmap?.[it]&&<span style={{width:10,height:10,borderRadius:"50%",background:cmap[it]}}/>}<span style={{fontSize:13}}>{it}</span>
    </div>))}
    {a?(<div style={{display:"flex",gap:4,padding:"4px 6px"}}><input value={nv} onChange={e=>snv(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&nv.trim()){oc([...items,nv.trim()]);snv("");sa(false);}}} placeholder="New..." style={{flex:1,padding:"3px 6px",border:"1px solid #ccc",borderRadius:4,fontSize:13}} autoFocus/></div>
    ):(<div onClick={()=>sa(true)} style={{padding:"6px 8px",color:"#0073ea",cursor:"pointer",fontSize:13,borderTop:"1px solid #eee",marginTop:4}}>+ Add new</div>)}
  </div></DD>);
};
const TDD=({anchorRef,open,onClose,allTags,sel,onToggle})=>(<DD anchorRef={anchorRef} open={open} onClose={onClose} w={180}><div style={{padding:6}}>
  <div style={{fontSize:11,color:"#666",padding:"4px 8px",fontWeight:600}}>Tags</div>
  {allTags.map((t,i)=>(<div key={i} onClick={()=>onToggle(t)} style={{display:"flex",alignItems:"center",padding:"5px 8px",borderRadius:4,cursor:"pointer",gap:8}} onMouseEnter={e=>e.currentTarget.style.background="#f5f5f5"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
    <span style={{width:16,height:16,borderRadius:3,border:"1.5px solid #ccc",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,background:sel.includes(t)?"#0073ea":"#fff",color:"#fff"}}>{sel.includes(t)?"✓":""}</span><span style={{fontSize:13}}>{t}</span>
  </div>))}
</div></DD>);

const Toast=({msg,onDone})=>{useEffect(()=>{const t=setTimeout(onDone,3000);return()=>clearTimeout(t);},[]);return(<div style={{position:"fixed",bottom:24,right:24,background:"#292f4c",color:"#fff",borderRadius:10,padding:"12px 20px",fontSize:13,boxShadow:"0 4px 24px rgba(0,0,0,.22)",zIndex:200000,maxWidth:360,display:"flex",alignItems:"center",gap:8}}><span style={{color:"#a25ddc"}}>⟲</span>{msg}</div>);};

const SidePanel=({title,sub,onClose,children,width=420})=>(<div style={{position:"fixed",right:0,top:0,bottom:0,width,background:"#fff",boxShadow:"-4px 0 20px rgba(0,0,0,.12)",zIndex:100000,display:"flex",flexDirection:"column",animation:"slideIn .2s ease"}}><style>{`@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
  <div style={{padding:"16px 20px",borderBottom:"1px solid #eee",display:"flex",alignItems:"center",justifyContent:"space-between"}}><div style={{flex:1,minWidth:0}}><div style={{fontSize:16,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{title}</div>{sub&&<div style={{fontSize:12,color:"#888",marginTop:2}}>{sub}</div>}</div><span onClick={onClose} style={{cursor:"pointer",fontSize:18,color:"#999",flexShrink:0,marginLeft:12}}>✕</span></div>{children}
</div>);

const TimelineCell=({row,onChange})=>{
  const [hov,setHov]=useState(false);const [ed,setEd]=useState(false);const od=isOverdue(row);
  const has=row.tlStart&&row.tlEnd;const label=fmtTL(row.tlStart,row.tlEnd);const dur=calcDur(row.tlStart,row.tlEnd,true);
  const bg=od?"#e2445c":SC[row.status]||"#579bfc";
  if(ed) return(<div style={{display:"flex",alignItems:"center",gap:2,width:"100%",padding:"2px"}}><input type="date" value={row.tlStart||""} onChange={e=>onChange("tlStart",e.target.value)} style={{border:"none",background:"transparent",fontSize:11,outline:"none",width:82,padding:1}}/><span style={{color:"#aaa",fontSize:9}}>→</span><input type="date" value={row.tlEnd||""} onChange={e=>onChange("tlEnd",e.target.value)} onBlur={()=>setTimeout(()=>setEd(false),200)} style={{border:"none",background:"transparent",fontSize:11,outline:"none",width:82,padding:1}}/></div>);
  return(<div onClick={()=>setEd(true)} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{width:"100%",padding:"3px 4px",cursor:"pointer",position:"relative"}}>
    {has?(<div style={{background:bg,borderRadius:4,padding:"4px 8px",textAlign:"center",color:"#fff",fontSize:11,fontWeight:600,position:"relative",whiteSpace:"nowrap"}}>{od&&"⚠ "}{label}
      {hov&&<div style={{position:"absolute",top:-30,left:"50%",transform:"translateX(-50%)",background:"#333",color:"#fff",padding:"3px 10px",borderRadius:4,fontSize:11,whiteSpace:"nowrap",zIndex:10,pointerEvents:"none"}}>{dur}{od?" · OVERDUE":""}</div>}
    </div>):(<div style={{color:"#ccc",fontSize:12,textAlign:"center"}}>—</div>)}
  </div>);
};
const StatusCell=({val,onChange,statuses,setStatuses})=>{
  const ref=useRef(null);const [open,setOpen]=useState(false);const [hov,setHov]=useState(false);const bg=SC[val]||"#c4c4c4";
  return([<div key="s" ref={ref} onClick={()=>setOpen(!open)} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{padding:"4px 6px",borderRadius:4,background:bg,color:"#fff",textAlign:"center",cursor:"pointer",fontSize:12,fontWeight:600,width:"100%",position:"relative",transition:"filter .15s"}}>
    {val||"—"}
    {hov&&val!=="Done"&&<div onClick={e=>{e.stopPropagation();onChange("status","Done");}} style={{position:"absolute",right:-2,top:"50%",transform:"translateY(-50%)",width:18,height:18,borderRadius:3,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 1px 4px rgba(0,0,0,.15)",zIndex:5,cursor:"pointer"}}><span style={{color:"#00c875",fontSize:10,fontWeight:800}}>✓</span></div>}
    {hov&&val==="Done"&&<div style={{position:"absolute",right:-2,top:"50%",transform:"translateY(-50%)",width:18,height:18,borderRadius:"50%",background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 1px 4px rgba(0,0,0,.15)",zIndex:5}}><span style={{color:"#00c875",fontSize:12,fontWeight:800}}>✓</span></div>}
  </div>,<EDD key="d" anchorRef={ref} open={open} onClose={()=>setOpen(false)} items={statuses} cmap={SC} label="Status" onSelect={v=>onChange("status",v)} oc={setStatuses}/>]);
};
const Cell=memo(({col,row,onChange,onOpenUpdates,onOpenDetail,people,setPeople,statuses,setStatuses,priorities,setPriorities,allTags,setAllTags,readonly,onEditLabels})=>{
  const ref=useRef(null);const [open,setOpen]=useState(false);const val=col.id==="updates"?(row.updates||[]):row[col.id];const od=isOverdue(row);
  /* READONLY: synced mirror rows */
  if(readonly&&col.type!=="updates"){
    const syncBadge=col.id==="task"?<span style={{marginLeft:4,fontSize:9,color:"#a25ddc",background:"#f0eeff",padding:"1px 5px",borderRadius:3,fontWeight:600,flexShrink:0}}>⇄ synced</span>:null;
    if(col.type==="status"){const bg=SC[val]||"#c4c4c4";return(<div style={{display:"flex",alignItems:"center",gap:4,width:"100%"}}><div style={{padding:"4px 6px",borderRadius:4,background:bg,color:"#fff",textAlign:"center",fontSize:12,fontWeight:600,flex:1,opacity:.8}}>{val||"—"} 🔒</div></div>);}
    if(col.type==="priority"){const bg=PC[val]||"#c4c4c4";return(<div style={{padding:"4px 6px",borderRadius:4,background:val&&val!=="No Priority"?bg:"transparent",color:val&&val!=="No Priority"?"#fff":"#aaa",textAlign:"center",fontSize:12,fontWeight:500,opacity:.8}}>{val&&val!=="No Priority"?val:"—"} 🔒</div>);}
    if(col.type==="person"){const ini=Initials(val);const ci=people.indexOf(val);return(<div style={{display:"flex",alignItems:"center",justifyContent:"center",width:"100%",opacity:.8}}>{val?<span title={val+" (synced)"} style={{width:28,height:28,borderRadius:"50%",background:CL[Math.abs(ci)%CL.length],color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700}}>{ini}</span>:<span style={{color:"#ccc",fontSize:12}}>—</span>}</div>);}
    if(col.type==="timeline") return(<div style={{padding:"4px 6px",fontSize:12,color:"#888",opacity:.8}}>{fmtTL(row.tlStart,row.tlEnd)||"—"} 🔒</div>);
    return(<div style={{display:"flex",alignItems:"center",width:"100%",padding:"6px 8px",fontSize:13,color:"#888",opacity:.8}}><span style={{flex:1}}>{String(val||"—")}</span>{syncBadge}<span style={{fontSize:9,color:"#ccc",marginLeft:2}}>🔒</span></div>);
  }
  if(col.type==="text") return(<div style={{display:"flex",alignItems:"center",width:"100%"}}><input value={val||""} onChange={e=>onChange(col.id,e.target.value)} style={{flex:1,border:"none",background:"transparent",padding:"6px 8px",fontSize:13,outline:"none",color:od&&col.id==="task"?"#e2445c":"#333",fontWeight:od&&col.id==="task"?600:400}}/>{col.id==="task"&&onOpenDetail&&<span onClick={e=>{e.stopPropagation();onOpenDetail();}} style={{cursor:"pointer",fontSize:11,color:"#bbb",padding:"0 4px",flexShrink:0,opacity:.6,transition:"opacity .15s"}} onMouseEnter={e=>e.currentTarget.style.opacity=1} onMouseLeave={e=>e.currentTarget.style.opacity=.6} title="Open">↗</span>}</div>);
  if(col.type==="number") return(<input type="number" value={val||""} onChange={e=>onChange(col.id,e.target.value)} style={{width:"100%",border:"none",background:"transparent",padding:"6px 8px",fontSize:13,outline:"none"}}/>);
  if(col.type==="timeline") return(<TimelineCell row={row} onChange={onChange}/>);
  if(col.type==="duration"){const d=calcDur(row.tlStart,row.tlEnd); return(<div style={{padding:"6px 8px",fontSize:13,color:d?"#333":"#ccc"}}>{d||"—"}</div>);}
  if(col.type==="updates"){const ct=Array.isArray(val)?val.length:0; return(<div onClick={onOpenUpdates} style={{display:"flex",alignItems:"center",justifyContent:"center",width:"100%",cursor:"pointer"}}>{ct>0?<span style={{background:"#0073ea",color:"#fff",borderRadius:12,padding:"2px 8px",fontSize:11,fontWeight:700}}>💬{ct}</span>:<span style={{color:"#ccc",fontSize:14}}>💬</span>}</div>);}
  if(col.type==="status") return(<StatusCell val={val} onChange={onChange} statuses={statuses} setStatuses={setStatuses}/>);
  if(col.type==="priority"){const np=val==="No Priority";const bg=PC[val]||"#c4c4c4"; return([<div key="p" ref={ref} onClick={()=>setOpen(!open)} style={{padding:"4px 6px",borderRadius:4,background:np?"transparent":bg,color:np?"#888":"#fff",textAlign:"center",cursor:"pointer",fontSize:12,fontWeight:500,width:"100%",border:np?"1px dashed #ccc":"none"}}>{np?"":val}</div>,<EDD key="d" anchorRef={ref} open={open} onClose={()=>setOpen(false)} items={priorities} cmap={PC} label="Priority" onSelect={v=>onChange(col.id,v)} oc={setPriorities}/>]);}
  if(col.type==="person"){const ini=Initials(val);const ci=people.indexOf(val); return([<div key="p" ref={ref} onClick={()=>setOpen(!open)} style={{cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",width:"100%"}}>{val?<span title={val} style={{width:28,height:28,borderRadius:"50%",background:CL[Math.abs(ci)%CL.length],color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,transition:"transform .15s"}} onMouseEnter={e=>e.currentTarget.style.transform="scale(1.1)"} onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>{ini}</span>:<span style={{width:28,height:28,borderRadius:"50%",border:"1.5px dashed #ccc",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:"#ccc"}}>+</span>}</div>,<EDD key="d" anchorRef={ref} open={open} onClose={()=>setOpen(false)} items={people} label="Person" onSelect={v=>onChange(col.id,v)} oc={setPeople}/>]);}
  if(col.type==="tags"){const tv=Array.isArray(val)?val:[];return([<div key="t" ref={ref} onClick={()=>setOpen(!open)} style={{cursor:"pointer",fontSize:12,color:"#999",padding:"4px 6px",width:"100%"}}>{tv.length>0?tv.map(t=><span key={t} style={{background:"#e6f0ff",color:"#0073ea",padding:"1px 5px",borderRadius:3,marginRight:2,fontSize:11}}>{t}</span>):"+"}</div>,<TDD key="d" anchorRef={ref} open={open} onClose={()=>setOpen(false)} allTags={allTags} sel={tv} onToggle={t=>{onChange(col.id,tv.includes(t)?tv.filter(x=>x!==t):[...tv,t]);}} oc={setAllTags}/>]);}
  if(col.type==="dropdown"){
    const labels=col.labels||["Option 1","Option 2","Option 3"];const lc={};labels.forEach((l,i)=>{lc[l]=DD_COLORS[i%DD_COLORS.length];});
    const bg=lc[val]||"transparent";const [adding,setAdding]=useState(false);const [nLabel,setNLabel]=useState("");
    return([<div key="dd" ref={ref} onClick={()=>setOpen(!open)} style={{padding:"4px 6px",borderRadius:4,background:val?bg:"transparent",color:val?"#fff":"#bbb",textAlign:"center",cursor:"pointer",fontSize:12,fontWeight:val?600:400,width:"100%",border:val?"none":"1px dashed #ccc"}}>{val||"Select"}</div>,
      <DD key="dm" anchorRef={ref} open={open} onClose={()=>{setOpen(false);setAdding(false);}} w={220}><div style={{padding:6}}>
        <div style={{fontSize:11,color:"#666",padding:"4px 8px",fontWeight:600}}>{col.name}</div>
        {labels.map((l,i)=>(<div key={l} onClick={()=>{onChange(col.id,l);setOpen(false);}} style={{display:"flex",alignItems:"center",padding:"6px 8px",borderRadius:4,cursor:"pointer",gap:8}} onMouseEnter={e=>e.currentTarget.style.background="#f5f5f5"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
          <span style={{width:12,height:12,borderRadius:3,background:DD_COLORS[i%DD_COLORS.length],flexShrink:0}}/>
          <span style={{fontSize:13,flex:1}}>{l}</span>
          {val===l&&<span style={{color:"#0073ea",fontSize:11}}>✓</span>}
        </div>))}
        {val&&<div onClick={()=>{onChange(col.id,"");setOpen(false);}} style={{padding:"5px 8px",borderRadius:4,cursor:"pointer",fontSize:12,color:"#e2445c",borderTop:"1px solid #eee",marginTop:4}} onMouseEnter={e=>e.currentTarget.style.background="#fff0f0"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>✕ Clear</div>}
        <div style={{borderTop:"1px solid #eee",marginTop:4,paddingTop:4}}>
          {adding?<div style={{display:"flex",gap:4,padding:"4px 6px"}}><input value={nLabel} onChange={e=>setNLabel(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&nLabel.trim()){if(onEditLabels)onEditLabels(col.id,[...labels,nLabel.trim()]);setNLabel("");setAdding(false);}}} placeholder="Label name..." style={{flex:1,padding:"4px 6px",border:"1px solid #ccc",borderRadius:4,fontSize:12,outline:"none"}} autoFocus/><span onClick={()=>setAdding(false)} style={{cursor:"pointer",color:"#999",fontSize:14,padding:"2px"}}>✕</span></div>
          :<div onClick={()=>setAdding(true)} style={{padding:"5px 8px",color:"#0073ea",cursor:"pointer",fontSize:12}}>+ Add label</div>}
        </div>
      </div></DD>
    ]);
  }
  if(col.type==="timer"){const m=parseInt(val)||0; return(<div style={{display:"flex",alignItems:"center",gap:4,width:"100%",justifyContent:"center"}}><span style={{fontSize:12,color:"#555"}}>{m}m</span><button onClick={()=>onChange(col.id,m+1)} style={{background:"#00c875",color:"#fff",border:"none",borderRadius:4,padding:"2px 6px",cursor:"pointer",fontSize:10}}>+</button></div>);}
  if(col.type==="date") return(<input type="date" value={val||""} onChange={e=>onChange(col.id,e.target.value)} style={{width:"100%",border:"none",background:"transparent",padding:"6px 8px",fontSize:12,outline:"none",color:val?"#333":"#ccc"}}/>);
  if(col.type==="link"){const [le,sle]=useState(false);return(<div style={{width:"100%",padding:"4px 6px"}}>{le?<input value={val||""} onChange={e=>onChange(col.id,e.target.value)} onBlur={()=>sle(false)} autoFocus placeholder="https://..." style={{width:"100%",border:"none",background:"transparent",fontSize:12,outline:"none",boxSizing:"border-box"}}/>:val?<a href={val} target="_blank" rel="noreferrer" style={{fontSize:12,color:"#0073ea",textDecoration:"none"}} onClick={e=>e.stopPropagation()}>{val.replace(/^https?:\/\//,"").slice(0,25)}</a>:<span onClick={()=>sle(true)} style={{color:"#ccc",fontSize:12,cursor:"pointer"}}>+ Add link</span>}</div>);}
  if(col.type==="checkbox") return(<div style={{display:"flex",alignItems:"center",justifyContent:"center",width:"100%"}}><input type="checkbox" checked={!!val} onChange={e=>onChange(col.id,e.target.checked)} style={{width:16,height:16,cursor:"pointer",accentColor:"#0073ea"}}/></div>);
  return(<span style={{padding:"6px 8px",fontSize:13}}>{String(val||"-")}</span>);
});

const Logo=({size=32})=>(<svg width={size} height={size} viewBox="0 0 40 40"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#8075f2"/><stop offset="100%" stopColor="#4530c7"/></linearGradient><linearGradient id="beam" x1=".3" y1="0" x2=".7" y2="1"><stop offset="0%" stopColor="#fff" stopOpacity="0"/><stop offset="30%" stopColor="#fff" stopOpacity=".9"/><stop offset="70%" stopColor="#fff" stopOpacity=".9"/><stop offset="100%" stopColor="#fff" stopOpacity="0"/></linearGradient></defs><rect rx="10" width="40" height="40" fill="url(#lg)"/><path d="M21 11c0 0-2.8-1.5-5.8-1.5-3.5 0-5.7 2-5.7 4.8 0 3 2.5 4.2 6 5.3 4.2 1.3 7.2 3.2 7.2 7 0 3.8-3.2 6-7.8 6-3 0-5-1-5-1" fill="none" stroke="rgba(255,255,255,.9)" strokeWidth="3.5" strokeLinecap="round"/><line x1="27" y1="3" x2="34" y2="37" stroke="url(#beam)" strokeWidth="2.8" strokeLinecap="round"/></svg>);
const UpdateInput=({onPost})=>{const[t,st]=useState("");return(<div style={{display:"flex",gap:8}}><input value={t} onChange={e=>st(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&t.trim()){onPost(t.trim());st("");}}} placeholder="Write an update..." style={{flex:1,padding:"8px 12px",border:"1px solid #ddd",borderRadius:6,fontSize:13,outline:"none"}}/><button onClick={()=>{if(t.trim()){onPost(t.trim());st("");}}} style={{background:"#0073ea",color:"#fff",border:"none",borderRadius:6,padding:"8px 16px",cursor:"pointer",fontSize:13,fontWeight:600}}>Post</button></div>);};

const CtxMenu=({pos,onClose,options})=>{
  const ref=useRef(null);
  useOutsideClick(ref,onClose);
  return(<div ref={ref} style={{position:"fixed",top:pos.y,left:pos.x,zIndex:100001,background:"#fff",border:"1px solid #e0e0e0",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,.15)",padding:6,minWidth:180}}>
    {options.map((o,i)=>o.divider?<div key={i} style={{borderTop:"1px solid #eee",margin:"4px 0"}}/>:
      <div key={i} onClick={()=>{o.fn();onClose();}} style={{padding:"7px 12px",fontSize:13,cursor:"pointer",borderRadius:4,color:o.danger?"#e2445c":"#333",display:"flex",alignItems:"center",gap:8}} onMouseEnter={e=>e.currentTarget.style.background=o.danger?"#fff0f0":"#f5f5f5"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        {o.icon&&<span style={{fontSize:12}}>{o.icon}</span>}{o.label}
      </div>
    )}
  </div>);
};

const FilterPanel=memo(({filters,setFilters,people,statuses,priorities,allTags,onClose,sortBy,setSortBy,hiddenCols,setHiddenCols})=>{
  const [tab,setTab]=useState("filter");
  const tog=(k,v)=>setFilters(f=>{const s=new Set(f[k]||[]);s.has(v)?s.delete(v):s.add(v);return{...f,[k]:[...s]};});
  const cnt=Object.values(filters).reduce((a,v)=>a+v.length,0);
  const SHOW_COLS=["Owner","Status","Priority","Timeline","Duration","Tags","Time Tracked","Updates"];
  return(<div style={{position:"absolute",top:"100%",left:0,zIndex:9999,background:"#fff",border:"1px solid #e0e0e0",borderRadius:10,boxShadow:"0 8px 30px rgba(0,0,0,.15)",width:380,maxHeight:480,overflowY:"auto"}}>
    <div style={{display:"flex",borderBottom:"1px solid #f0f0f0"}}>
      {[["filter","Filter"],["sort","Sort"],["columns","Columns"]].map(([k,l])=>(<button key={k} onClick={()=>setTab(k)} style={{flex:1,padding:"9px 0",border:"none",background:tab===k?"#f5f3ff":"#fff",color:tab===k?"#6c5ce7":"#666",fontWeight:tab===k?700:400,cursor:"pointer",fontSize:12,borderBottom:tab===k?"2px solid #6c5ce7":"2px solid transparent"}}>{l}</button>))}
      <button onClick={onClose} style={{background:"none",border:"none",fontSize:16,cursor:"pointer",color:"#888",padding:"0 10px"}}>✕</button>
    </div>
    {tab==="filter"&&<div style={{padding:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><span style={{fontSize:13,fontWeight:700}}>Filters {cnt>0&&<span style={{background:"#6c5ce7",color:"#fff",borderRadius:8,padding:"1px 7px",fontSize:11}}>{cnt}</span>}</span>{cnt>0&&<span onClick={()=>setFilters({status:[],owner:[],priority:[],tags:[]})} style={{fontSize:12,color:"#e2445c",cursor:"pointer"}}>Clear all</span>}</div>
      {[{k:"status",l:"Status",items:statuses,c:SC},{k:"owner",l:"Owner",items:people},{k:"priority",l:"Priority",items:priorities,c:PC},{k:"tags",l:"Tags",items:allTags}].map(s=>(<div key={s.k} style={{marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:700,color:"#666",marginBottom:5}}>{s.l}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{s.items.map(it=>{const sel=(filters[s.k]||[]).includes(it);return(<div key={it} onClick={()=>tog(s.k,it)} style={{padding:"3px 10px",borderRadius:16,fontSize:11,cursor:"pointer",border:sel?"1.5px solid #6c5ce7":"1.5px solid #e0e0e0",background:sel?"#f0eeff":"#fff",color:sel?"#6c5ce7":"#555",fontWeight:sel?600:400,display:"flex",alignItems:"center",gap:4}}>{s.c?.[it]&&<span style={{width:7,height:7,borderRadius:"50%",background:s.c[it]}}/>}{it}</div>);})}</div>
      </div>))}
    </div>}
    {tab==="sort"&&<div style={{padding:14}}>
      <div style={{fontSize:12,color:"#888",marginBottom:10}}>Sort all items by:</div>
      {["Default","Name","Status","Priority","Owner"].map(s=>(<button key={s} onClick={()=>setSortBy(s)} style={{display:"block",width:"100%",textAlign:"left",padding:"8px 12px",border:"none",borderRadius:6,cursor:"pointer",background:sortBy===s?"#f0eeff":"transparent",color:sortBy===s?"#6c5ce7":"#333",fontWeight:sortBy===s?700:400,fontSize:13,marginBottom:3}}>{sortBy===s?"● ":""}{s}</button>))}
    </div>}
    {tab==="columns"&&<div style={{padding:14}}>
      <div style={{fontSize:12,color:"#888",marginBottom:10}}>Show / hide columns:</div>
      {SHOW_COLS.map(c=>{const hidden=(hiddenCols||[]).includes(c);return(<div key={c} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #f5f5f5"}}>
        <span style={{fontSize:13}}>{c}</span>
        <button onClick={()=>setHiddenCols(prev=>hidden?prev.filter(x=>x!==c):[...prev,c])} style={{background:hidden?"#f5f6f8":"#6c5ce7",border:"none",borderRadius:20,padding:"3px 12px",fontSize:11,color:hidden?"#888":"#fff",cursor:"pointer",fontWeight:700}}>{hidden?"Hidden":"Visible"}</button>
      </div>);})}
    </div>}
  </div>);
});

const ProgBar=memo(({rows})=>{const t=rows.length;if(!t) return (null);const d=rows.filter(r=>r.status==="Done").length;const p=Math.round(d/t*100);return(<div style={{display:"flex",alignItems:"center",gap:6,marginLeft:8}}><div style={{width:60,height:5,background:"rgba(255,255,255,.3)",borderRadius:3,overflow:"hidden"}}><div style={{width:p+"%",height:"100%",background:"#fff",borderRadius:3,transition:"width .3s"}}/></div><span style={{fontSize:10,color:"rgba(255,255,255,.8)"}}>{p}%</span></div>);});

const KanbanView=memo(({statuses,allRows})=>(<div style={{display:"flex",gap:12,overflowX:"auto",padding:"8px 0",minHeight:400}}>
  {statuses.map(s=>{const items=allRows.filter(({row})=>(row.status||"Not Started")===s);return(<div key={s} style={{minWidth:220,maxWidth:260,flex:"0 0 240px",background:"#f7f8fa",borderRadius:10,display:"flex",flexDirection:"column"}}>
    <div style={{padding:"10px 14px",display:"flex",alignItems:"center",gap:8}}><span style={{width:10,height:10,borderRadius:"50%",background:SC[s]||"#ccc"}}/><span style={{fontSize:13,fontWeight:700,flex:1}}>{s}</span><span style={{fontSize:11,color:"#999",background:"#e6e9ef",borderRadius:8,padding:"0 6px"}}>{items.length}</span></div>
    <div style={{flex:1,overflowY:"auto",padding:"0 8px 8px"}}>{items.map(({row})=>(<div key={row.id} style={{background:"#fff",borderRadius:8,padding:"10px 12px",marginBottom:6,border:isOverdue(row)?"1.5px solid #e2445c":"1px solid #e6e9ef",boxShadow:"0 1px 3px rgba(0,0,0,.04)",cursor:"pointer",transition:"box-shadow .15s"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 3px 12px rgba(0,0,0,.1)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="0 1px 3px rgba(0,0,0,.04)"}>
      <div style={{fontSize:13,fontWeight:600,marginBottom:6,color:isOverdue(row)?"#e2445c":"#333"}}>{isOverdue(row)&&"⚠ "}{row.task||"Untitled"}</div>
      <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>{row.owner&&<span style={{fontSize:10,background:"#e6f0ff",color:"#0073ea",padding:"1px 6px",borderRadius:3}}>{row.owner}</span>}{row.priority&&row.priority!=="No Priority"&&<span style={{fontSize:10,padding:"1px 6px",borderRadius:3,background:PC[row.priority],color:"#fff"}}>{row.priority}</span>}{row.tlStart&&<span style={{fontSize:9,color:"#888"}}>{fmtTL(row.tlStart,row.tlEnd)}</span>}</div>
    </div>))}</div>
  </div>);})}
</div>));

const DashView=memo(({allRows})=>{
  const sd=useMemo(()=>{const m={};allRows.forEach(({row})=>{const s=row.status||"Not Started";m[s]=(m[s]||0)+1;});return Object.entries(m).map(([k,v])=>({name:k,value:v,color:SC[k]||"#ccc"}));},[allRows]);
  const od=useMemo(()=>{const m={};allRows.forEach(({row})=>{const o=row.owner||"Unassigned";m[o]=(m[o]||0)+1;});return Object.entries(m).map(([k,v])=>({name:k,value:v}));},[allRows]);
  const t=allRows.length,d=allRows.filter(r=>r.row.status==="Done").length,s=allRows.filter(r=>r.row.status==="Stuck").length,ov=allRows.filter(r=>isOverdue(r.row)).length;
  return(<div style={{padding:"8px 0"}}>
    <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap"}}>
      {[{l:"Total",v:t,c:"#0073ea"},{l:"Done",v:d,c:"#00c875"},{l:"Stuck",v:s,c:"#e2445c"},{l:"Overdue",v:ov,c:"#ff642e"},{l:"Completion",v:t?Math.round(d/t*100)+"%":"0%",c:"#a25ddc"}].map(x=>(<div key={x.l} style={{flex:"1 1 120px",background:"#fff",borderRadius:10,padding:"16px 20px",border:"1px solid #e6e9ef"}}><div style={{fontSize:24,fontWeight:800,color:x.c}}>{x.v}</div><div style={{fontSize:12,color:"#888",marginTop:2}}>{x.l}</div></div>))}
    </div>
    <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
      <div style={{flex:"1 1 300px",background:"#fff",borderRadius:10,padding:20,border:"1px solid #e6e9ef"}}><div style={{fontSize:14,fontWeight:700,marginBottom:12}}>Status</div><ResponsiveContainer width="100%" height={200}><PieChart><Pie data={sd} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" label={({name,percent})=>`${name} ${(percent*100).toFixed(0)}%`} labelLine={false} style={{fontSize:9}}>{sd.map((e,i)=>(<RCell key={i} fill={e.color}/>))}</Pie><Tooltip/></PieChart></ResponsiveContainer></div>
      <div style={{flex:"1 1 300px",background:"#fff",borderRadius:10,padding:20,border:"1px solid #e6e9ef"}}><div style={{fontSize:14,fontWeight:700,marginBottom:12}}>By Owner</div><ResponsiveContainer width="100%" height={200}><BarChart data={od}><XAxis dataKey="name" tick={{fontSize:10}} angle={-20} textAnchor="end" height={50}/><YAxis allowDecimals={false} tick={{fontSize:10}}/><Tooltip/><Bar dataKey="value" fill="#579bfc" radius={[4,4,0,0]}/></BarChart></ResponsiveContainer></div>
    </div>
  </div>);
});

const GanttView=memo(({allRows})=>{
  const wt=allRows.filter(({row})=>row.tlStart&&row.tlEnd);if(!wt.length) return(<div style={{padding:40,textAlign:"center",color:"#aaa"}}>No tasks with timeline set.</div>);
  const ad=wt.flatMap(({row})=>[new Date(row.tlStart),new Date(row.tlEnd)]);const mn=new Date(Math.min(...ad)),mx=new Date(Math.max(...ad));
  const days=[];for(let d=new Date(mn);d<=mx;d.setDate(d.getDate()+1))days.push(new Date(d));const cw=Math.max(24,Math.min(50,700/days.length));
  return(<div style={{overflowX:"auto"}}><div style={{display:"flex",minWidth:days.length*cw+220}}>
    <div style={{width:220,flexShrink:0,borderRight:"1px solid #e6e9ef"}}><div style={{height:40,padding:"8px 12px",fontWeight:700,fontSize:12,color:"#666",borderBottom:"1px solid #e6e9ef"}}>Task</div>
      {wt.map(({row})=>(<div key={row.id} style={{height:34,padding:"0 12px",display:"flex",alignItems:"center",fontSize:12,borderBottom:"1px solid #f5f5f5",color:isOverdue(row)?"#e2445c":"#333",fontWeight:isOverdue(row)?600:400}}>{isOverdue(row)&&"⚠ "}{(row.task||"").slice(0,28)}</div>))}</div>
    <div style={{flex:1}}><div style={{display:"flex",height:40,borderBottom:"1px solid #e6e9ef"}}>{days.map((d,i)=>{const isToday=d.toDateString()===new Date().toDateString();return(<div key={i} style={{width:cw,flexShrink:0,textAlign:"center",fontSize:8,color:isToday?"#0073ea":"#999",padding:"4px 0",borderRight:"1px solid #f5f5f5",background:isToday?"#e6f0ff":"transparent",fontWeight:isToday?700:400}}><div>{d.toLocaleDateString("en-US",{month:"short"})}</div><div>{d.getDate()}</div></div>);})}</div>
      {wt.map(({row})=>{const s=new Date(row.tlStart),e=new Date(row.tlEnd),l=((s-mn)/(864e5))*cw,w=Math.max(cw/2,((e-s)/(864e5))*cw);return(<div key={row.id} style={{height:34,position:"relative",borderBottom:"1px solid #f5f5f5"}}><div style={{position:"absolute",left:l,top:7,width:w,height:20,background:isOverdue(row)?"#e2445c":SC[row.status]||"#579bfc",borderRadius:4,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:9,fontWeight:600,overflow:"hidden",padding:"0 3px",transition:"filter .15s"}} onMouseEnter={e2=>e2.currentTarget.style.filter="brightness(1.1)"} onMouseLeave={e2=>e2.currentTarget.style.filter="brightness(1)"}>{(row.task||"").slice(0,18)}</div></div>);})}</div>
  </div></div>);
});

const DASH_PRESETS=[
  {id:"kpi",label:"KPI Cards",emoji:"📈",type:"kpi",dim:"status"},
  {id:"status",label:"Status Chart",emoji:"📊",type:"pie",dim:"status"},
  {id:"priority",label:"Priority Chart",emoji:"🎯",type:"bar",dim:"priority"},
  {id:"workload",label:"Workload",emoji:"👥",type:"hbar",dim:"owner"},
  {id:"boardProg",label:"Board Progress",emoji:"📋",type:"progress",dim:"board"},
  {id:"overdue",label:"Overdue",emoji:"⚠️",type:"list",dim:"overdue"},
  {id:"activity",label:"Activity",emoji:"🕐",type:"list",dim:"activity"},
  {id:"tags",label:"Tags",emoji:"🏷️",type:"chips",dim:"tags"},
];
const CHART_TYPES=[
  {id:"pie",label:"Pie Chart",emoji:"🍩"},
  {id:"bar",label:"Bar Chart",emoji:"📊"},
  {id:"hbar",label:"Horizontal Bar",emoji:"📉"},
  {id:"number",label:"Number Card",emoji:"🔢"},
  {id:"list",label:"Item List",emoji:"📋"},
  {id:"note",label:"Text Note",emoji:"📝"},
];
const DATA_DIMS=[
  {id:"status",label:"Status"},
  {id:"priority",label:"Priority"},
  {id:"owner",label:"Owner"},
  {id:"tags",label:"Tags"},
  {id:"board",label:"Board"},
  {id:"overdue",label:"Overdue Items"},
  {id:"done",label:"Completed Items"},
  {id:"stuck",label:"Stuck Items"},
  {id:"inprogress",label:"In Progress Items"},
];

const DashboardBoard=memo(({boards})=>{
  const [widgets,setWidgets]=useState(()=>DASH_PRESETS.map(w=>({...w,on:true,custom:false})));
  const [drillIn,setDrillIn]=useState(null);
  const [addOpen,setAddOpen]=useState(false);
  const [addStep,setAddStep]=useState(1);
  const [addType,setAddType]=useState("pie");
  const [addDim,setAddDim]=useState("status");
  const [addTitle,setAddTitle]=useState("");
  const [addNoteText,setAddNoteText]=useState("");
  /* Canvas drag */
  const [cDrag,setCDrag]=useState(null);
  const [cOver,setCOver]=useState(null);

  const onCanvasDrop=(toId)=>{
    if(cDrag==null||cDrag===toId)return;
    setWidgets(prev=>{const n=[...prev];const fi=n.findIndex(w=>w.id===cDrag);const ti=n.findIndex(w=>w.id===toId);if(fi<0||ti<0)return prev;const[moved]=n.splice(fi,1);n.splice(ti,0,moved);return n;});
    setCDrag(null);setCOver(null);
  };

  const taskBoards=boards.filter(b=>!b.isMain&&!b.isDashboard&&!b.isSummary);
  const allRows=useMemo(()=>taskBoards.flatMap(b=>b.groups.flatMap(g=>g.rows.map(r=>({...r,_board:b.name,_boardIcon:b.icon||"📋"})))),[taskBoards]);
  const total=allRows.length,done=allRows.filter(r=>r.status==="Done").length,stuck=allRows.filter(r=>r.status==="Stuck").length;
  const inProg=allRows.filter(r=>r.status==="In Progress"||r.status==="Working on it").length;
  const pct=total?Math.round(done/total*100):0;
  const overdueItems=useMemo(()=>allRows.filter(r=>isOverdue(r)),[allRows]);

  /* Data aggregation by dimension */
  const AGG_COLORS=["#579bfc","#00c875","#fdab3d","#e2445c","#a25ddc","#ff642e","#037f4c","#ff5ac4","#bb3354","#6c5ce7"];
  const agg=useCallback((dim)=>{
    const m={};
    if(dim==="status") allRows.forEach(r=>{const k=r.status||"Not Started";m[k]=(m[k]||0)+1;});
    else if(dim==="priority") allRows.forEach(r=>{const k=r.priority||"No Priority";m[k]=(m[k]||0)+1;});
    else if(dim==="owner") allRows.forEach(r=>{const k=r.owner||"Unassigned";m[k]=(m[k]||0)+1;});
    else if(dim==="tags") allRows.forEach(r=>(r.tags||[]).forEach(t=>{m[t]=(m[t]||0)+1;}));
    else if(dim==="board") taskBoards.forEach(b=>{m[b.name]=b.groups.flatMap(g=>g.rows).length;});
    else if(dim==="overdue") return overdueItems.map((r,i)=>({name:r.task||"Untitled",value:1,item:r,color:AGG_COLORS[i%AGG_COLORS.length]}));
    else if(dim==="done") allRows.filter(r=>r.status==="Done").forEach(r=>{m[r._board||"Unknown"]=(m[r._board||"Unknown"]||0)+1;});
    else if(dim==="stuck") allRows.filter(r=>r.status==="Stuck").forEach(r=>{m[r._board||"Unknown"]=(m[r._board||"Unknown"]||0)+1;});
    else if(dim==="inprogress") allRows.filter(r=>r.status==="In Progress"||r.status==="Working on it").forEach(r=>{m[r._board||"Unknown"]=(m[r._board||"Unknown"]||0)+1;});
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([k,v],i)=>({name:k,value:v,color:SC[k]||PC[k]||AGG_COLORS[i%AGG_COLORS.length]}));
  },[allRows,taskBoards,overdueItems]);

  const boardStats=useMemo(()=>taskBoards.map(b=>{const rows=b.groups.flatMap(g=>g.rows);const t=rows.length,d=rows.filter(r=>r.status==="Done").length;return{name:b.name,icon:b.icon||"📋",total:t,done:d,pct:t?Math.round(d/t*100):0,stuck:rows.filter(r=>r.status==="Stuck").length};}),[taskBoards]);
  const recentHist=useMemo(()=>boards.flatMap(b=>(b.hist||[]).map(h=>({...h,boardName:b.name,boardIcon:b.icon}))).sort((a,b)=>(b.time||"").localeCompare(a.time||"")).slice(0,20),[boards]);

  /* drill */
  const drill=(title,items)=>setDrillIn({title,items,filter:""});
  const drillDim=(dim,name)=>{
    let items=[];
    if(!name){
      if(dim==="overdue") items=overdueItems;
      else if(dim==="done") items=allRows.filter(r=>r.status==="Done");
      else if(dim==="stuck") items=allRows.filter(r=>r.status==="Stuck");
      else if(dim==="inprogress") items=allRows.filter(r=>r.status==="In Progress"||r.status==="Working on it");
      else items=allRows;
    }
    else if(dim==="status") items=allRows.filter(r=>(r.status||"Not Started")===name);
    else if(dim==="priority") items=allRows.filter(r=>(r.priority||"No Priority")===name);
    else if(dim==="owner") items=allRows.filter(r=>(r.owner||"Unassigned")===name);
    else if(dim==="tags") items=allRows.filter(r=>(r.tags||[]).includes(name));
    else if(dim==="board") items=allRows.filter(r=>r._board===name);
    else if(dim==="overdue") items=overdueItems;
    else if(dim==="done") items=allRows.filter(r=>r.status==="Done");
    else if(dim==="stuck") items=allRows.filter(r=>r.status==="Stuck");
    else if(dim==="inprogress") items=allRows.filter(r=>r.status==="In Progress"||r.status==="Working on it");
    if(items.length) drill((name||dim),items);
  };

  /* Generic chart renderers */
  const renderPie=(data,dim)=>{
    if(!data.length)return(<div style={{textAlign:"center",color:"#ccc",padding:30}}>No data</div>);
    return(<div>
      <ResponsiveContainer width="100%" height={180}><PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={42} outerRadius={70} dataKey="value" label={false} labelLine={false} style={{cursor:"pointer"}} onClick={(_,idx)=>drillDim(dim,data[idx]?.name)}>{data.map((e,i)=>(<RCell key={i} fill={e.color} style={{cursor:"pointer"}}/>))}</Pie>
        <Tooltip formatter={(v,n)=>[v+" items",n]}/>
      </PieChart></ResponsiveContainer>
      <div style={{display:"flex",flexWrap:"wrap",gap:"4px 12px",justifyContent:"center",marginTop:4}}>
        {data.map(d=>(<div key={d.name} onClick={()=>drillDim(dim,d.name)} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",fontSize:11,color:"#555"}}>
          <span style={{width:8,height:8,borderRadius:2,background:d.color,flexShrink:0}}/>
          <span>{d.name}</span>
          <span style={{color:"#aaa",fontWeight:700}}>{d.value}</span>
        </div>))}
      </div>
    </div>);
  };

  const renderBar=(data,dim)=>data.length?<ResponsiveContainer width="100%" height={200}><BarChart data={data} margin={{top:5,right:5,bottom:5,left:0}}><XAxis dataKey="name" tick={{fontSize:10}} interval={0} angle={data.length>5?-30:0} textAnchor={data.length>5?"end":"middle"} height={data.length>5?50:30}/><YAxis allowDecimals={false} tick={{fontSize:10}} width={30}/><Tooltip/><Bar dataKey="value" radius={[4,4,0,0]} cursor="pointer" onClick={d=>drillDim(dim,d?.name)}>{data.map((e,i)=>(<RCell key={i} fill={e.color}/>))}</Bar></BarChart></ResponsiveContainer>:<div style={{textAlign:"center",color:"#ccc",padding:30}}>No data</div>;

  const renderHBar=(data,dim)=>data.length?<ResponsiveContainer width="100%" height={Math.max(100,data.length*34)}><BarChart data={data} layout="vertical" margin={{top:5,right:10,bottom:5,left:5}}><XAxis type="number" allowDecimals={false} tick={{fontSize:10}}/><YAxis type="category" dataKey="name" tick={{fontSize:11}} width={80}/><Tooltip/><Bar dataKey="value" fill="#579bfc" radius={[0,4,4,0]} cursor="pointer" onClick={d=>drillDim(dim,d?.name)}/></BarChart></ResponsiveContainer>:<div style={{textAlign:"center",color:"#ccc",padding:20}}>No data</div>;

  const renderNumber=(data,dim)=>{const t=data.reduce((s,d)=>s+d.value,0);return(<div onClick={()=>drillDim(dim,null)} style={{textAlign:"center",padding:20,cursor:"pointer"}}><div style={{fontSize:42,fontWeight:800,color:"#6c5ce7"}}>{t}</div><div style={{fontSize:12,color:"#888"}}>{data.length} categories</div></div>);};

  const renderList=(items,dim)=>items.length===0?<div style={{color:"#aaa",fontSize:12,padding:10}}>Empty</div>:<div>{items.slice(0,6).map((r,i)=>(<div key={r.id||r.name||i} onClick={()=>{if(r.item)drill(r.item.task,[r.item]);else drillDim(dim,r.name);}} style={{fontSize:12,padding:"4px 0",borderBottom:"1px solid #f7f7f7",cursor:"pointer",display:"flex",gap:6,alignItems:"center"}}><span style={{fontWeight:600,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.item?r.item.task:r.name}</span><span style={{color:"#888",fontSize:11}}>{r.item?(r.item.owner||""):""+r.value}</span></div>))}{items.length>6&&<div style={{fontSize:10,color:"#aaa",padding:"4px 0"}}>+{items.length-6} more</div>}</div>;

  /* Render a single widget by its config */
  const renderWidget=(w)=>{
    /* Built-in special widgets */
    if(w.id==="kpi"&&!w.custom){
      const card=(label,val,color,items)=>(<div onClick={()=>{if(items?.length)drill(label,items);}} style={{flex:"1 1 120px",background:"#fff",borderRadius:8,padding:"12px 14px",border:"1px solid #e6e9ef",position:"relative",overflow:"hidden",cursor:items?.length?"pointer":"default"}} onMouseEnter={e=>{if(items?.length)e.currentTarget.style.borderColor="#579bfc";}} onMouseLeave={e=>e.currentTarget.style.borderColor="#e6e9ef"}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:color}}/><div style={{fontSize:22,fontWeight:800,color}}>{val}</div><div style={{fontSize:10,color:"#888"}}>{label}</div></div>);
      return (<div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        {card("Total",total,"#0073ea",null)}
        {card("Done",done,"#00c875",allRows.filter(r=>r.status==="Done"))}
        {card("In Progress",inProg,"#fdab3d",allRows.filter(r=>r.status==="In Progress"||r.status==="Working on it"))}
        {card("Stuck",stuck,"#e2445c",allRows.filter(r=>r.status==="Stuck"))}
        {card("Overdue",overdueItems.length,"#ff642e",overdueItems)}
        {card("Done %",pct+"%","#6c5ce7",null)}
      </div>);
    }
    if(w.id==="boardProg"&&!w.custom){
      return boardStats.length===0?<div style={{color:"#ccc",fontSize:12}}>No boards</div>
        :<div>{boardStats.map(b=>(<div key={b.name} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,cursor:"pointer"}} onClick={()=>drill(b.name,allRows.filter(r=>r._board===b.name))}>
          <span style={{fontSize:12,minWidth:90,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.icon} {b.name}</span>
          <div style={{flex:1,height:8,borderRadius:4,background:"#f0f0f0",overflow:"hidden"}}><div style={{width:b.pct+"%",height:8,borderRadius:4,background:b.pct===100?"#00c875":"#6c5ce7",transition:"width .4s"}}/></div>
          <span style={{fontSize:11,fontWeight:700,color:b.pct===100?"#00c875":"#6c5ce7",minWidth:30}}>{b.pct}%</span>
        </div>))}</div>;
    }
    if(w.id==="activity"&&!w.custom){
      return recentHist.length===0?<div style={{color:"#aaa",fontSize:12}}>No activity</div>
        :<div>{recentHist.slice(0,6).map((h,i)=>(<div key={i} style={{fontSize:11,padding:"3px 0",borderBottom:"1px solid #f7f7f7",color:"#666"}}><b>{h.action}</b> {(h.detail||"").slice(0,40)} <span style={{color:"#aaa"}}>· {h.boardName}</span></div>))}</div>;
    }
    if(w.type==="note"){
      return (<textarea value={w.text||""} onChange={e=>{const v=e.target.value;setWidgets(ws=>ws.map(x=>x.id===w.id?{...x,text:v}:x));}} placeholder="Type your note..." style={{width:"100%",border:"none",outline:"none",resize:"vertical",fontSize:12,background:"transparent",fontFamily:"inherit",minHeight:50,boxSizing:"border-box"}}/>);
    }
    /* Generic chart/list rendering based on type + dim */
    const data=agg(w.dim);
    if(w.type==="pie") return renderPie(data,w.dim);
    if(w.type==="bar") return renderBar(data,w.dim);
    if(w.type==="hbar") return renderHBar(data,w.dim);
    if(w.type==="number") return renderNumber(data,w.dim);
    if(w.type==="list") return renderList(data,w.dim);
    if(w.type==="chips") return data.length>0?<div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{data.map(d=>(<div key={d.name} onClick={()=>drillDim(w.dim,d.name)} style={{background:"#f5f6f8",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12,display:"flex",gap:4,alignItems:"center"}} onMouseEnter={e=>e.currentTarget.style.background="#e6f0ff"} onMouseLeave={e=>e.currentTarget.style.background="#f5f6f8"}><span style={{fontWeight:600}}>{d.name}</span><span style={{color:"#888"}}>{d.value}</span></div>))}</div>:<div style={{color:"#ccc",fontSize:12}}>No data</div>;
    return (<div style={{color:"#ccc",fontSize:12}}>Unknown type</div>);
  };

  /* DrillPanel with filter - inline JSX, not inner component */
  const drillFilt=drillIn?.filter||"";
  const drillShown=drillIn?(drillIn.items||[]).filter(r=>{if(!drillFilt)return true;const q=drillFilt.toLowerCase();return(r.task||"").toLowerCase().includes(q)||(r.owner||"").toLowerCase().includes(q)||(r._board||"").toLowerCase().includes(q);}):[];
  const drillPanel=drillIn?(<div style={{position:"fixed",top:0,right:0,bottom:0,width:460,background:"#fff",boxShadow:"-4px 0 24px rgba(0,0,0,.15)",zIndex:100010,display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>
    <div style={{padding:"14px 18px",borderBottom:"1px solid #e6e9ef",display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontSize:15,fontWeight:700,flex:1}}>{drillIn.title}</span>
      <span style={{background:"#e6f0ff",color:"#0073ea",borderRadius:8,padding:"2px 10px",fontSize:12,fontWeight:700}}>{drillShown.length}</span>
      <button onClick={()=>setDrillIn(null)} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#999"}}>✕</button>
    </div>
    <div style={{padding:"8px 18px",borderBottom:"1px solid #f0f0f0"}}>
      <input value={drillFilt} onChange={e=>setDrillIn(d=>({...d,filter:e.target.value}))} placeholder="Filter items..." style={{width:"100%",border:"1px solid #e0e0e0",borderRadius:6,padding:"6px 10px",fontSize:12,outline:"none",boxSizing:"border-box"}}/>
    </div>
    <div style={{flex:1,overflowY:"auto",padding:8}}>
      {drillShown.length===0?<div style={{textAlign:"center",color:"#ccc",padding:30}}>No matching items</div>
      :drillShown.map((r,i)=>(<div key={r.id||i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:i%2?"#fafbfc":"#fff",borderRadius:6,marginBottom:1}}>
        <div style={{width:3,height:28,borderRadius:2,background:SC[r.status]||"#ccc",flexShrink:0}}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:isOverdue(r)?"#e2445c":"#333"}}>{r.task||"Untitled"}</div>
          <div style={{fontSize:10,color:"#999"}}>{r._boardIcon} {r._board}{r.owner?" · "+r.owner:""}{r.tlEnd?" · "+r.tlEnd:""}</div>
        </div>
        <span style={{background:SC[r.status]||"#ccc",color:"#fff",borderRadius:3,padding:"1px 6px",fontSize:9,fontWeight:700,flexShrink:0}}>{r.status}</span>
      </div>))}
    </div>
  </div>):null;

  const resetAdd=()=>{setAddOpen(false);setAddStep(1);setAddType("pie");setAddDim("status");setAddTitle("");setAddNoteText("");};
  const createWidget=()=>{
    const id="custom_"+uid();
    const label=addTitle||(DATA_DIMS.find(d=>d.id===addDim)?.label||addDim)+" "+(CHART_TYPES.find(c=>c.id===addType)?.label||"");
    const w={id,label,emoji:CHART_TYPES.find(c=>c.id===addType)?.emoji||"📊",type:addType,dim:addDim,on:true,custom:true};
    if(addType==="note") w.text=addNoteText;
    setWidgets(prev=>[...prev,w]);
    resetAdd();
  };

  const addWidgetModal=addOpen?(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.35)",zIndex:100012,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={resetAdd}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:12,width:400,boxShadow:"0 12px 48px rgba(0,0,0,.2)",overflow:"hidden"}}>
        <div style={{padding:"16px 20px",borderBottom:"1px solid #e6e9ef",display:"flex",alignItems:"center"}}>
          <span style={{fontSize:16,fontWeight:700,flex:1}}>Add Widget {addStep>1?"("+addStep+"/3)":""}</span>
          <button onClick={resetAdd} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#999"}}>✕</button>
        </div>
        <div style={{padding:20}}>
          {addStep===1&&<>
            <div style={{fontSize:12,color:"#888",marginBottom:10}}>Choose chart type:</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {CHART_TYPES.map(ct=>(<div key={ct.id} onClick={()=>setAddType(ct.id)} style={{border:"2px solid "+(addType===ct.id?"#6c5ce7":"#e6e9ef"),borderRadius:8,padding:"12px 8px",cursor:"pointer",textAlign:"center",background:addType===ct.id?"#f5f3ff":"#fff",transition:"all .1s"}}>
                <div style={{fontSize:20}}>{ct.emoji}</div>
                <div style={{fontSize:11,fontWeight:600,color:addType===ct.id?"#6c5ce7":"#555",marginTop:4}}>{ct.label}</div>
              </div>))}
            </div>
            <button onClick={()=>setAddStep(addType==="note"?3:2)} style={{marginTop:16,width:"100%",padding:"8px",border:"none",borderRadius:6,background:"#6c5ce7",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>Next →</button>
          </>}
          {addStep===2&&<>
            <div style={{fontSize:12,color:"#888",marginBottom:10}}>What data should it display?</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {DATA_DIMS.map(dd=>(<div key={dd.id} onClick={()=>setAddDim(dd.id)} style={{border:"2px solid "+(addDim===dd.id?"#6c5ce7":"#e6e9ef"),borderRadius:8,padding:"10px 12px",cursor:"pointer",background:addDim===dd.id?"#f5f3ff":"#fff",fontSize:13,fontWeight:addDim===dd.id?700:400,color:addDim===dd.id?"#6c5ce7":"#555"}}>{dd.label}</div>))}
            </div>
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={()=>setAddStep(1)} style={{flex:1,padding:"8px",border:"1px solid #e0e0e0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:12}}>← Back</button>
              <button onClick={()=>setAddStep(3)} style={{flex:1,padding:"8px",border:"none",borderRadius:6,background:"#6c5ce7",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>Next →</button>
            </div>
          </>}
          {addStep===3&&<>
            <div style={{fontSize:12,color:"#888",marginBottom:10}}>Name your widget:</div>
            <input value={addTitle} onChange={e=>setAddTitle(e.target.value)} placeholder={addType==="note"?"Note title":"e.g. Tasks by Owner"} style={{width:"100%",padding:"8px 12px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:14,outline:"none",boxSizing:"border-box",marginBottom:12}}/>
            {addType!=="note"&&<div style={{fontSize:11,color:"#aaa",marginBottom:12,background:"#f5f6f8",borderRadius:6,padding:8}}>Preview: {CHART_TYPES.find(c=>c.id===addType)?.emoji} {CHART_TYPES.find(c=>c.id===addType)?.label} showing {DATA_DIMS.find(d=>d.id===addDim)?.label}</div>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setAddStep(addType==="note"?1:2)} style={{flex:1,padding:"8px",border:"1px solid #e0e0e0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:12}}>← Back</button>
              <button onClick={createWidget} style={{flex:1,padding:"8px",border:"none",borderRadius:6,background:"#6c5ce7",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>Create Widget</button>
            </div>
          </>}
        </div>
      </div>
    </div>):null;

  const visible=widgets.filter(w=>w.on);
  const hidden=widgets.filter(w=>!w.on);

  return(<div style={{padding:"4px 0",maxWidth:1200}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
      <button onClick={()=>setAddOpen(true)} style={{padding:"6px 14px",borderRadius:6,border:"1px dashed #6c5ce7",background:"#f8f6ff",cursor:"pointer",fontSize:12,fontWeight:700,color:"#6c5ce7"}}>+ Add Widget</button>
      {hidden.length>0&&<><span style={{fontSize:11,color:"#aaa",marginLeft:8}}>Hidden:</span>{hidden.map(w=>(<button key={w.id} onClick={()=>setWidgets(ws=>ws.map(x=>x.id===w.id?{...x,on:true}:x))} style={{background:"#f5f6f8",border:"none",borderRadius:4,padding:"3px 10px",cursor:"pointer",fontSize:11,color:"#888"}}>{w.emoji} {w.label} +</button>))}</>}
    </div>

    {/* Widget grid */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
      {visible.map(w=>{
        const isOver=cOver===w.id;const isDrag=cDrag===w.id;
        const isFullRow=w.id==="kpi"&&!w.custom;
        return(<div key={w.id} draggable onDragStart={()=>setCDrag(w.id)} onDragEnd={()=>{setCDrag(null);setCOver(null);}}
          onDragOver={e=>{e.preventDefault();setCOver(w.id);}} onDrop={e=>{e.preventDefault();onCanvasDrop(w.id);}}
          style={{gridColumn:isFullRow?"1/-1":"auto",opacity:isDrag?0.3:1,outline:isOver?"2px dashed #6c5ce7":"none",outlineOffset:2,transition:"all .12s"}}>
          <div style={{background:w.type==="note"?"#fffef5":"#fff",borderRadius:10,border:"1px solid "+(w.type==="note"?"#f0e8c0":"#e6e9ef"),padding:isFullRow?0:14,position:"relative"}}>
            {/* Widget header (not for KPI row) */}
            {!isFullRow&&<div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
              <span style={{cursor:"grab",color:"#d0d0d0",fontSize:11,userSelect:"none"}}>⠿</span>
              <span style={{fontSize:12,fontWeight:700,flex:1,color:"#444"}}>{w.emoji} {w.label}</span>
              <button onClick={()=>setWidgets(ws=>ws.map(x=>x.id===w.id?{...x,on:false}:x))} title="Hide" style={{background:"none",border:"none",cursor:"pointer",color:"#d0d0d0",fontSize:12,padding:0}} onMouseEnter={e=>e.currentTarget.style.color="#e2445c"} onMouseLeave={e=>e.currentTarget.style.color="#d0d0d0"}>✕</button>
              {w.custom&&<button onClick={()=>setWidgets(ws=>ws.filter(x=>x.id!==w.id))} title="Delete" style={{background:"none",border:"none",cursor:"pointer",color:"#d0d0d0",fontSize:11,padding:0}} onMouseEnter={e=>e.currentTarget.style.color="#e2445c"} onMouseLeave={e=>e.currentTarget.style.color="#d0d0d0"}>🗑</button>}
            </div>}
            {isFullRow&&<div style={{padding:"14px 14px 10px"}}>{renderWidget(w)}</div>}
            {!isFullRow&&renderWidget(w)}
          </div>
        </div>);
      })}
    </div>

    {addWidgetModal}
    {drillPanel}
  </div>);
});

/* ─── Executive Summary Board (lean VP view) ─── */
const daysDiff=(d)=>{if(!d)return 999;const t=new Date(d),n=new Date();t.setHours(0,0,0,0);n.setHours(0,0,0,0);return Math.ceil((t-n)/(864e5));};

const SummaryBoard=memo(({boards,boardId,onChangeSrc})=>{
  const taskBoards=boards.filter(b=>!b.isMain&&!b.isDashboard&&!b.isSummary);
  const srcId=boardId||"all";
  const srcRows=useMemo(()=>{
    if(srcId==="all")return taskBoards.flatMap(b=>b.groups.flatMap(g=>g.rows.map(r=>({...r,_board:b.name}))));
    const b=boards.find(x=>x.id===srcId);
    return b?b.groups.flatMap(g=>g.rows.map(r=>({...r,_board:b.name}))):[];
  },[srcId,boards,taskBoards]);

  const blocked=srcRows.filter(r=>{const t=((r.task||"")+" "+(r.notes||"")).toLowerCase();return r.status==="Stuck"||t.includes("block")||t.includes("approv")||t.includes("waiting");});
  const upcoming=srcRows.filter(r=>!blocked.find(x=>x.id===r.id)&&r.status!=="Done"&&(isOverdue(r)||(r.tlEnd&&daysDiff(r.tlEnd)<=7&&daysDiff(r.tlEnd)>=0)));
  const active=srcRows.filter(r=>r.status!=="Done"&&!blocked.find(x=>x.id===r.id)&&!upcoming.find(x=>x.id===r.id));
  const doneItems=srcRows.filter(r=>r.status==="Done");

  const tag=(r)=>{
    if(isOverdue(r))return (<span style={{color:"#e2445c",fontSize:10,fontWeight:700}}> OVERDUE</span>);
    const d=daysDiff(r.tlEnd);if(d>=0&&d<=3)return (<span style={{color:"#fdab3d",fontSize:10,fontWeight:700}}> {d}d</span>);
    return null;
  };

  const sec=(emoji,title,color,items,empty)=>(<div style={{marginBottom:18}}>
    <div style={{fontSize:13,fontWeight:700,color:"#1f1f3b",marginBottom:4,paddingBottom:4,borderBottom:"2px solid "+color+"30",display:"flex",alignItems:"center",gap:6}}>
      <span>{emoji}</span>{title}{items.length>0&&<span style={{fontSize:11,color:"#888",fontWeight:400}}>({items.length})</span>}
    </div>
    {items.length===0?<div style={{color:"#ccc",fontSize:12,fontStyle:"italic"}}>{empty}</div>
    :items.slice(0,8).map(r=>(<div key={r.id} style={{padding:"3px 0",fontSize:12,display:"flex",alignItems:"center",gap:4}}>
      <span style={{color}}>•</span>
      <span style={{fontWeight:500,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.task}</span>
      {r.owner&&<span style={{color:"#999",fontSize:10}}>{r.owner}</span>}
      {tag(r)}
    </div>))}
    {items.length>8&&<div style={{fontSize:10,color:"#aaa"}}>+{items.length-8} more</div>}
  </div>);

  return(<div style={{padding:"4px 0",maxWidth:700}}>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
      <select value={srcId} onChange={e=>onChangeSrc(e.target.value)} style={{padding:"5px 10px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:12,outline:"none"}}>
        <option value="all">All boards</option>
        {taskBoards.map(b=>(<option key={b.id} value={b.id}>{b.icon} {b.name}</option>))}
      </select>
      <span style={{fontSize:11,color:"#aaa"}}>{srcRows.filter(r=>r.status!=="Done").length} active · {doneItems.length} done</span>
    </div>
    {sec("🚫","Blockers","#e2445c",blocked,"All clear")}
    {sec("📅","Deadlines","#fdab3d",upcoming,"None upcoming")}
    {sec("📌","Active Work","#579bfc",active,"No active items")}
    {sec("✅","Done","#00c875",doneItems.slice(0,5),"Nothing closed yet")}
  </div>);
});

const DetailPanel=({row,gId,onUpdate,onAddUpdate,onClose,people,statuses,priorities})=>{
  const [tab,setTab]=useState("details");
  return(<SidePanel title={row.task||"Untitled"} sub="Item details" onClose={onClose} width={500}>
    <div style={{display:"flex",borderBottom:"1px solid #eee",padding:"0 20px"}}>{["details","updates","activity"].map(t=>(<div key={t} onClick={()=>setTab(t)} style={{padding:"10px 16px",fontSize:13,fontWeight:tab===t?600:400,borderBottom:tab===t?"2px solid #0073ea":"2px solid transparent",cursor:"pointer",color:tab===t?"#0073ea":"#666",textTransform:"capitalize"}}>{t}</div>))}</div>
    <div style={{flex:1,overflowY:"auto",padding:20}}>
      {tab==="details"&&<div>
        {[{l:"Task",k:"task",t:"text"},{l:"Owner",k:"owner",t:"s",o:people},{l:"Status",k:"status",t:"s",o:statuses},{l:"Priority",k:"priority",t:"s",o:priorities},{l:"Start",k:"tlStart",t:"date"},{l:"End",k:"tlEnd",t:"date"}].map(f=>(<div key={f.k} style={{display:"flex",alignItems:"center",marginBottom:10,gap:12}}><div style={{width:100,fontSize:12,fontWeight:600,color:"#666",flexShrink:0}}>{f.l}</div><div style={{flex:1}}>{f.t==="text"?<input value={row[f.k]||""} onChange={e=>onUpdate(f.k,e.target.value)} style={{width:"100%",padding:"6px 10px",border:"1px solid #ddd",borderRadius:6,fontSize:13,outline:"none",boxSizing:"border-box"}}/>:f.t==="date"?<input type="date" value={row[f.k]||""} onChange={e=>onUpdate(f.k,e.target.value)} style={{padding:"6px 10px",border:"1px solid #ddd",borderRadius:6,fontSize:13,outline:"none"}}/>:<select value={row[f.k]||""} onChange={e=>onUpdate(f.k,e.target.value)} style={{padding:"6px 10px",border:"1px solid #ddd",borderRadius:6,fontSize:13,outline:"none",width:"100%"}}>{f.o.map(o=>(<option key={o}>{o}</option>))}</select>}</div></div>))}
        {isOverdue(row)&&<div style={{padding:"8px 12px",background:"#fff0f0",borderRadius:6,border:"1px solid #ffd0d0",color:"#e2445c",fontSize:12,fontWeight:600,marginBottom:10}}>⚠ This item is overdue</div>}
        {row.tags?.length>0&&<div style={{marginBottom:12}}><span style={{fontSize:12,fontWeight:600,color:"#666"}}>Tags: </span>{row.tags.map(t=>(<span key={t} style={{background:"#e6f0ff",color:"#0073ea",padding:"2px 8px",borderRadius:4,fontSize:11,marginRight:4}}>{t}</span>))}</div>}
        <div style={{borderTop:"1px solid #f0f0f0",paddingTop:12,marginTop:4}}>
          <div style={{fontSize:12,fontWeight:700,color:"#666",marginBottom:10}}>COMPLETION TRACKING</div>
          {[{l:"Completion Date",k:"completionDate",t:"date"},{l:"Completion Status",k:"completionStatus",t:"s",o:COMP_STATS},{l:"Dependent On",k:"dependentOn",t:"text"},{l:"Planned Effort",k:"plannedEffort",t:"text"},{l:"Effort Spent",k:"effortSpent",t:"text"}].map(f=>(<div key={f.k} style={{display:"flex",alignItems:"center",marginBottom:10,gap:12}}><div style={{width:100,fontSize:12,fontWeight:600,color:"#666",flexShrink:0}}>{f.l}</div><div style={{flex:1}}>{f.t==="text"?<input value={row[f.k]||""} onChange={e=>onUpdate(f.k,e.target.value)} style={{width:"100%",padding:"5px 10px",border:"1px solid #ddd",borderRadius:6,fontSize:12,outline:"none",boxSizing:"border-box"}} placeholder="-"/>:f.t==="date"?<input type="date" value={row[f.k]||""} onChange={e=>onUpdate(f.k,e.target.value)} style={{padding:"5px 10px",border:"1px solid #ddd",borderRadius:6,fontSize:12,outline:"none"}}/>:<select value={row[f.k]||"-"} onChange={e=>onUpdate(f.k,e.target.value)} style={{padding:"5px 10px",border:"1px solid #ddd",borderRadius:6,fontSize:12,outline:"none",width:"100%",background:COMP_SC[row[f.k]]?COMP_SC[row[f.k]]+"20":"transparent"}}>{f.o.map(o=>(<option key={o}>{o}</option>))}</select>}</div></div>))}
        </div>
        <div style={{borderTop:"1px solid #f0f0f0",paddingTop:12,marginTop:4}}>
          <div style={{fontSize:12,fontWeight:700,color:"#666",marginBottom:6}}>NOTES</div>
          <textarea value={row.notes||""} onChange={e=>onUpdate("notes",e.target.value)} placeholder="Add notes..." rows={3} style={{width:"100%",border:"1px solid #ddd",borderRadius:6,padding:"8px 10px",fontSize:12,outline:"none",resize:"vertical",fontFamily:"inherit",boxSizing:"border-box"}}/>
        </div>
        {(row.subitems||[]).length>0&&<div style={{marginTop:12,borderTop:"1px solid #f0f0f0",paddingTop:12}}><div style={{fontSize:12,fontWeight:700,color:"#666",marginBottom:8}}>SUBITEMS ({row.subitems.length})</div>{row.subitems.map(si=>(<div key={si.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:"#f7f8fa",borderRadius:6,marginBottom:4}}><span style={{flex:1,fontSize:12}}>{si.task||"Untitled"}</span><span style={{fontSize:11,padding:"2px 6px",borderRadius:3,background:SC[si.status]||"#ccc",color:"#fff"}}>{si.status}</span></div>))}</div>}
      </div>}
      {tab==="updates"&&<div>{(row.updates||[]).length===0&&<div style={{color:"#aaa",textAlign:"center",padding:30,fontSize:13}}>No updates</div>}{(row.updates||[]).slice().reverse().map(u=>(<div key={u.id} style={{marginBottom:10,padding:"10px 14px",background:"#f7f8fa",borderRadius:8,borderLeft:"3px solid #0073ea"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontSize:12,fontWeight:600}}>{u.author}</span><span style={{fontSize:11,color:"#999"}}>{u.time}</span></div><div style={{fontSize:13,color:"#444"}}>{u.text}</div></div>))}<div style={{marginTop:12}}><UpdateInput onPost={t=>onAddUpdate(t)}/></div></div>}
      {tab==="activity"&&<div style={{fontSize:13,color:"#888"}}><div style={{padding:"8px 0",borderBottom:"1px solid #f0f0f0"}}>Item created</div>{(row.updates||[]).map(u=>(<div key={u.id} style={{padding:"8px 0",borderBottom:"1px solid #f0f0f0"}}><b>{u.author}</b> posted update — {u.time}</div>))}{row.completionDate&&<div style={{padding:"8px 0",background:"#f0fff4",borderRadius:4,paddingLeft:8,marginTop:4}}><b>✓ Completed</b> — {row.completionDate} {row.completionStatus&&row.completionStatus!=="-"&&<span style={{background:COMP_SC[row.completionStatus],color:"#fff",borderRadius:4,padding:"1px 6px",fontSize:11,marginLeft:4}}>{row.completionStatus}</span>}</div>}</div>}
    </div>
  </SidePanel>);
};

const NotifsPanel=({notifs,setNotifs,onClose})=>(<SidePanel title="🔔 Notifications" onClose={onClose} width={380}>
  <div style={{padding:"8px 16px",borderBottom:"1px solid #eee",display:"flex",gap:8}}><button onClick={()=>setNotifs(n=>n.map(x=>({...x,read:true})))} style={{fontSize:12,color:"#0073ea",background:"none",border:"none",cursor:"pointer"}}>Mark all read</button></div>
  <div style={{flex:1,overflowY:"auto",padding:12}}>{notifs.map(n=>(<div key={n.id} onClick={()=>setNotifs(ns=>ns.map(x=>x.id===n.id?{...x,read:true}:x))} style={{padding:"12px 14px",background:n.read?"transparent":"#f0f7ff",borderRadius:8,marginBottom:4,cursor:"pointer",borderLeft:n.read?"3px solid transparent":`3px solid ${n.type==="warning"?"#fdab3d":n.type==="success"?"#00c875":"#0073ea"}`,transition:"background .15s"}} onMouseEnter={e=>e.currentTarget.style.background=n.read?"#f7f8fa":"#e6f0ff"} onMouseLeave={e=>e.currentTarget.style.background=n.read?"transparent":"#f0f7ff"}>
    <div style={{fontSize:13,color:"#333",fontWeight:n.read?400:600}}>{n.type==="warning"?"⚠️ ":n.type==="success"?"✅ ":"💬 "}{n.text}</div>
    <div style={{fontSize:11,color:"#999",marginTop:4}}>{n.time}</div>
  </div>))}</div>
</SidePanel>);

const ActivityPanel=({boards,onClose})=>{
  const events=useMemo(()=>{const ev=[];boards.forEach(b=>{(b.hist||[]).forEach(h=>{ev.push({...h,board:b.name});});b.groups.forEach(g=>{g.rows.forEach(r=>{(r.updates||[]).forEach(u=>{ev.push({action:"Update",detail:`${u.author}: "${u.text.slice(0,40)}"`,time:u.time,board:b.name,color:"#0073ea"});});});});});return ev.slice(-30).reverse();},[boards]);
  return(<SidePanel title="📊 Activity Feed" sub="All boards" onClose={onClose} width={420}>
    <div style={{flex:1,overflowY:"auto",padding:16}}>{events.length===0&&<div style={{color:"#aaa",textAlign:"center",padding:30}}>No activity yet</div>}
      {events.map((e,i)=>(<div key={i} style={{marginBottom:8,padding:"8px 12px",background:"#f7f8fa",borderRadius:6,borderLeft:`3px solid ${e.color||"#579bfc"}`}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:12,fontWeight:600}}>{e.action}</span><span style={{fontSize:10,color:"#999"}}>{e.time}</span></div>{e.detail&&<div style={{fontSize:12,color:"#666",marginTop:2}}>{e.detail}</div>}<div style={{fontSize:10,color:"#aaa",marginTop:2}}>{e.board}</div></div>))}
    </div>
  </SidePanel>);
};

const ColCtxMenu=({pos,col,onClose,onSort,onAddCol,onRename,onHide,onDelete,colTypes})=>{
  const ref=useRef(null);const [addSub,setAddSub]=useState(col?null:"right");
  useEffect(()=>{const h=e=>{if(!ref.current?.contains(e.target))onClose();};document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);},[onClose]);
  return(<div ref={ref} style={{position:"fixed",top:pos.y,left:pos.x,zIndex:100002,background:"#fff",border:"1px solid #e0e0e0",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,.18)",padding:6,minWidth:200}}>
    {!addSub&&<>
      <div style={{padding:"4px 10px",fontSize:10,fontWeight:700,color:"#999",letterSpacing:".5px"}}>COLUMN: {col?.name||"New"}</div>
      {(col?[
        {icon:"↑",label:"Sort ascending",fn:()=>{onSort("asc");onClose();}},
        {icon:"↓",label:"Sort descending",fn:()=>{onSort("desc");onClose();}},
        {divider:true},
        {icon:"✎",label:"Rename column",fn:()=>{onRename();onClose();}},
        {icon:"👁",label:"Hide column",fn:()=>{onHide();onClose();}},
        {divider:true},
        {icon:"←+",label:"Add column left",fn:()=>setAddSub("left")},
        {icon:"+→",label:"Add column right",fn:()=>setAddSub("right")},
        {divider:true},
        {icon:"🗑",label:"Delete column",danger:true,fn:()=>{onDelete();onClose();}},
      ]:[{icon:"+",label:"Add new column",fn:()=>setAddSub("right")}]).map((o,i)=>o.divider?<div key={i} style={{borderTop:"1px solid #eee",margin:"4px 0"}}/>:
        <div key={i} onClick={o.fn} style={{padding:"7px 12px",fontSize:13,cursor:"pointer",borderRadius:4,color:o.danger?"#e2445c":"#333",display:"flex",alignItems:"center",gap:8}} onMouseEnter={e=>e.currentTarget.style.background=o.danger?"#fff0f0":"#f5f5f5"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
          <span style={{fontSize:12,width:18,textAlign:"center"}}>{o.icon}</span>{o.label}
        </div>
      )}
    </>}
    {addSub&&<div>
      <div onClick={()=>setAddSub(null)} style={{padding:"6px 10px",fontSize:12,color:"#0073ea",cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>← Back</div>
      <div style={{padding:"4px 10px",fontSize:10,fontWeight:700,color:"#999",letterSpacing:".5px"}}>SELECT COLUMN TYPE</div>
      {colTypes.map(ct=>(<div key={ct.type} onClick={()=>{onAddCol(addSub,ct.type,ct.label);onClose();}} style={{padding:"7px 12px",fontSize:13,cursor:"pointer",borderRadius:4,display:"flex",alignItems:"center",gap:10}} onMouseEnter={e=>e.currentTarget.style.background="#f5f5f5"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        <span style={{width:22,height:22,borderRadius:4,background:"#f0f2f5",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12}}>{ct.icon}</span>
        <span>{ct.label}</span>
      </div>))}
    </div>}
  </div>);
};

const SyncModal=({board,allBoards,onClose,onAddSync,onRemoveSync})=>{
  const targets=board?.syncTargets||[];
  const available=allBoards.filter(b=>b.id!==board?.id&&!targets.some(t=>t.boardId===b.id));
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",zIndex:100000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}><div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:12,width:480,padding:24,maxHeight:"80vh",overflowY:"auto"}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}><h3 style={{margin:0}}>🔗 Sync "{board?.name}" to boards</h3><span onClick={onClose} style={{cursor:"pointer",fontSize:18,color:"#999"}}>✕</span></div>
    <p style={{fontSize:13,color:"#666",margin:"0 0 16px"}}>Connect this board to other boards. Changes here will automatically sync status, progress, and updates as a row on the target board.</p>
    {targets.length>0&&<div style={{marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:700,color:"#666",marginBottom:8}}>CURRENTLY SYNCED TO</div>
      {targets.map(t=>{const tb=allBoards.find(b=>b.id===t.boardId);return(<div key={t.boardId} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#f5f3ff",borderRadius:8,marginBottom:6,border:"1px solid #e0d8ff"}}>
        <span style={{fontSize:14}}>{tb?.icon||"📋"}</span>
        <span style={{flex:1,fontSize:13,fontWeight:600,color:"#333"}}>{tb?.name||"Unknown"}</span>
        <span style={{fontSize:11,color:"#a25ddc",background:"#f0eeff",padding:"2px 8px",borderRadius:10}}>Live sync</span>
        <span onClick={()=>onRemoveSync(t.boardId)} style={{cursor:"pointer",color:"#e2445c",fontSize:12,fontWeight:700}}>✕</span>
      </div>);})}
    </div>}
    {board?.linkedMainBoardId&&<div style={{marginBottom:16,padding:"8px 12px",background:"#f0fffe",borderRadius:8,border:"1px solid #d8ffe8",fontSize:12,color:"#037f4c"}}>
      📊 Also synced to portfolio: <b>{allBoards.find(b=>b.id===board.linkedMainBoardId)?.name}</b> (primary link)
    </div>}
    <div style={{fontSize:12,fontWeight:700,color:"#666",marginBottom:8}}>ADD NEW SYNC TARGET</div>
    {available.length===0?<div style={{color:"#aaa",fontSize:13,padding:12,textAlign:"center"}}>No more boards available to sync to</div>
    :<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
      {available.map(b=>(<div key={b.id} onClick={()=>onAddSync(b.id)} style={{padding:"12px 14px",border:"1px solid #e6e9ef",borderRadius:8,cursor:"pointer",transition:"all .15s",display:"flex",alignItems:"center",gap:8}} onMouseEnter={e=>{e.currentTarget.style.borderColor="#0073ea";e.currentTarget.style.background="#f0f7ff";}} onMouseLeave={e=>{e.currentTarget.style.borderColor="#e6e9ef";e.currentTarget.style.background="transparent";}}>
        <span style={{fontSize:16}}>{b.icon||"📋"}</span>
        <div><div style={{fontSize:13,fontWeight:600}}>{b.name}</div><div style={{fontSize:10,color:"#999"}}>{b.cat} • {b.groups.reduce((a,g)=>a+g.rows.length,0)} items</div></div>
      </div>))}
    </div>}
  </div></div>);
};

const BOARD_ICONS=["📋","💻","🎫","🔧","🔒","📊","🚀","📁","📝","📈","🎯","⚡","🔬","🧪","📦","🛠","📡","🗂","💡","🌐","🏗","📑","🔔","🧩","🎨","📌","🗓","🏷","💬","🤖"];

const ConfirmModal=({message,onConfirm,onCancel})=>(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",zIndex:200000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onCancel}>
  <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:12,padding:"24px 28px",width:360,boxShadow:"0 12px 40px rgba(0,0,0,.2)"}}>
    <div style={{fontSize:15,fontWeight:700,marginBottom:6,color:"#1f1f3b"}}>Are you sure?</div>
    <div style={{fontSize:13,color:"#666",marginBottom:20,lineHeight:1.5}}>{message}</div>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
      <button onClick={onCancel} style={{padding:"8px 20px",border:"1px solid #e0e0e0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:13,fontWeight:500}}>Cancel</button>
      <button onClick={onConfirm} style={{padding:"8px 20px",border:"none",borderRadius:6,background:"#e2445c",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>Delete</button>
    </div>
  </div>
</div>);

const TemplateModal=memo(({onSelect,onClose,boards,mainBoards})=>{
  const [mode,setMode]=useState("template");const [name,setName]=useState("");const [linkTo,setLinkTo]=useState("");const [linkItem,setLinkItem]=useState("");const [folder,setFolder]=useState("ACTIVE");const [icon,setIcon]=useState("📋");const [iconOpen,setIconOpen]=useState(false);
  const mbs=(mainBoards||boards.filter(b=>b.isMain));
  const items=linkTo?((mbs.find(b=>b.id===linkTo)||{groups:[]}).groups.flatMap(g=>g.rows)):[];
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",zIndex:100000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}><div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:12,width:560,padding:24,maxHeight:"85vh",overflowY:"auto"}}>
  <h3 style={{margin:"0 0 4px"}}>Create new board</h3><p style={{color:"#888",fontSize:13,margin:"0 0 16px"}}>Start from a template or create a linked task board</p>
  <div style={{display:"flex",gap:8,marginBottom:16}}>
    {[["template","📋 Template"],["linked","🔗 Linked Board"]].map(([k,l])=>(<button key={k} onClick={()=>setMode(k)} style={{flex:1,padding:"10px",borderRadius:8,border:mode===k?"2px solid #6c5ce7":"2px solid #e0e0e0",background:mode===k?"#f5f3ff":"#fff",cursor:"pointer",fontSize:13,fontWeight:mode===k?700:400,color:mode===k?"#6c5ce7":"#555"}}>{l}</button>))}
  </div>
  {mode==="template"&&<div>
    <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
      <label style={{fontSize:12,color:"#666",fontWeight:600}}>Board icon:</label>
      <div style={{position:"relative",display:"inline-block"}}><div onClick={()=>setIconOpen(!iconOpen)} style={{width:36,height:36,borderRadius:6,border:"2px solid "+(iconOpen?"#6c5ce7":"#e0e0e0"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,cursor:"pointer",background:iconOpen?"#f5f3ff":"#fafafa",transition:"all .15s"}}>{icon}</div>
        {iconOpen&&<div style={{position:"absolute",top:"100%",left:0,marginTop:6,background:"#fff",border:"1px solid #e0e0e0",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,.15)",padding:10,display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:4,width:240,zIndex:10}}>
          {BOARD_ICONS.map(ic=>(<div key={ic} onClick={()=>{setIcon(ic);setIconOpen(false);}} style={{width:34,height:34,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,cursor:"pointer",background:icon===ic?"#f0eeff":"transparent",border:icon===ic?"2px solid #6c5ce7":"2px solid transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background=icon===ic?"#f0eeff":"transparent"}>{ic}</div>))}
        </div>}
      </div>
      <span style={{fontSize:11,color:"#aaa"}}>Pick an icon, then click a template</span>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>{BOARD_TEMPLATES.map((t,i)=>(<div key={i} onClick={()=>onSelect({...t,icon:icon||t.icon})} style={{padding:"16px",border:"1px solid #e6e9ef",borderRadius:10,cursor:"pointer",transition:"all .15s"}} onMouseEnter={e=>{e.currentTarget.style.borderColor="#0073ea";e.currentTarget.style.boxShadow="0 2px 8px rgba(0,115,234,.15)";}} onMouseLeave={e=>{e.currentTarget.style.borderColor="#e6e9ef";e.currentTarget.style.boxShadow="none";}}>
    <div style={{fontSize:20,marginBottom:6}}>{t.icon}</div><div style={{fontSize:14,fontWeight:700}}>{t.name}</div><div style={{fontSize:11,color:"#999",marginTop:4}}>{t.groups.length} groups</div>
  </div>))}</div></div>}
  {mode==="linked"&&<div>
    <div style={{marginBottom:12}}><label style={{fontSize:12,color:"#666",fontWeight:600,display:"block",marginBottom:4}}>Board icon</label>
      <div style={{position:"relative",display:"inline-block"}}><div onClick={()=>setIconOpen(!iconOpen)} style={{width:44,height:44,borderRadius:8,border:"2px solid "+(iconOpen?"#6c5ce7":"#e0e0e0"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,cursor:"pointer",background:iconOpen?"#f5f3ff":"#fafafa",transition:"all .15s"}}>{icon}</div>
        {iconOpen&&<div style={{position:"absolute",top:"100%",left:0,marginTop:6,background:"#fff",border:"1px solid #e0e0e0",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,.15)",padding:10,display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:4,width:240,zIndex:10}}>
          {BOARD_ICONS.map(ic=>(<div key={ic} onClick={()=>{setIcon(ic);setIconOpen(false);}} style={{width:34,height:34,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,cursor:"pointer",background:icon===ic?"#f0eeff":"transparent",border:icon===ic?"2px solid #6c5ce7":"2px solid transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background=icon===ic?"#f0eeff":"transparent"}>{ic}</div>))}
        </div>}
      </div>
    </div>
    <div style={{marginBottom:12}}><label style={{fontSize:12,color:"#666",fontWeight:600,display:"block",marginBottom:4}}>Board name</label><input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Sprint Board, Phase 2 Rollout" style={{width:"100%",padding:"8px 12px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:13,outline:"none",boxSizing:"border-box"}}/></div>
    <div style={{marginBottom:12}}><label style={{fontSize:12,color:"#666",fontWeight:600,display:"block",marginBottom:4}}>Folder</label><select value={folder} onChange={e=>setFolder(e.target.value)} style={{width:"100%",padding:"7px 10px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:13}}>{BOARD_CATS.map(c=><option key={c}>{c}</option>)}</select></div>
    {mbs.length>0&&<div style={{background:"#f8f5ff",borderRadius:8,padding:14,border:"1px solid #e0d8ff",marginBottom:12}}>
      <label style={{fontSize:12,color:"#6c5ce7",fontWeight:700,display:"block",marginBottom:6}}>🔗 Link to Portfolio Board</label>
      <select value={linkTo} onChange={e=>{setLinkTo(e.target.value);setLinkItem("");}} style={{width:"100%",padding:"6px 10px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:13,marginBottom:8}}>
        <option value="">– No link –</option>{mbs.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {linkTo&&<><label style={{fontSize:11,color:"#888",display:"block",marginBottom:4}}>Link to which project?</label><select value={linkItem} onChange={e=>setLinkItem(e.target.value)} style={{width:"100%",padding:"6px 10px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:13}}>
        <option value="">– Select project –</option>{items.map(i=><option key={i.id} value={i.task}>{i.task}</option>)}
      </select></>}
    </div>}
    <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}><button onClick={onClose} style={{padding:"8px 20px",border:"1px solid #e0e0e0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:13}}>Cancel</button>
    <button onClick={()=>{if(name.trim()){onSelect({name:name.trim(),icon:icon,groups:[{name:"Group 1",color:"#579bfc"}],linked:true,linkTo:linkTo||null,linkItem:linkItem||null,folder});}}} style={{padding:"8px 20px",border:"none",borderRadius:6,background:"linear-gradient(135deg,#6c5ce7,#0984e3)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>Create</button></div>
  </div>}
</div></div>);
});

const SelectionBar=({count,groups,statuses,priorities,onDuplicate,onDelete,onMove,onSetStatus,onSetPriority,onDeselect})=>{
  const [moveOpen,setMoveOpen]=useState(false);const [statusOpen,setStatusOpen]=useState(false);const [prioOpen,setPrioOpen]=useState(false);
  const ref=useRef(null);
  useOutsideClick(ref,()=>{setMoveOpen(false);setStatusOpen(false);setPrioOpen(false);});
  if(!count)return null;
  const ic=(svg)=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{__html:svg}}/>;
  const icons={
    dup:ic('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>'),
    move:ic('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
    status:ic('<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/>'),
    prio:ic('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 2 9.27l6.91-1.01z"/>'),
    del:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
  };
  const btn=(icon,label,onClick,danger)=>(<div onClick={onClick} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer",padding:"6px 14px",borderRadius:8,minWidth:56,transition:"background .15s"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.12)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{typeof icon==="string"?<span dangerouslySetInnerHTML={{__html:icon}}/>:icon}<span style={{fontSize:11,color:danger?"#ff6b6b":"rgba(255,255,255,0.9)",whiteSpace:"nowrap",fontWeight:500}}>{label}</span></div>);
  const pop=(items,onSelect,onClose)=>(<div style={{position:"absolute",bottom:"100%",left:"50%",transform:"translateX(-50%)",marginBottom:8,background:"#fff",borderRadius:10,boxShadow:"0 8px 32px rgba(0,0,0,.25)",minWidth:180,maxHeight:260,overflowY:"auto",zIndex:200001}} onClick={e=>e.stopPropagation()}>
    <div style={{padding:"8px 12px",borderBottom:"1px solid #f0f0f0",fontSize:11,color:"#888",fontWeight:600}}>Select to apply to {count} item{count>1?"s":""}</div>
    {items.map((it,i)=>(<div key={i} onClick={()=>{onSelect(it.value||it.label||it);onClose();}} style={{padding:"9px 14px",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",gap:10,borderBottom:i<items.length-1?"1px solid #f8f8f8":"none"}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      {it.color&&<span style={{width:12,height:12,borderRadius:4,background:it.color,flexShrink:0}}/>}
      <span style={{fontWeight:500}}>{it.label||it}</span>
    </div>))}
  </div>);
  return(<div ref={ref} style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:"#292f4c",borderRadius:14,padding:"10px 16px",display:"flex",alignItems:"center",gap:2,boxShadow:"0 8px 40px rgba(0,0,0,.4)",zIndex:200000,animation:"barSlide .25s ease"}}>
    <style>{`@keyframes barSlide{from{transform:translateX(-50%) translateY(80px);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}`}</style>
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"4px 16px 4px 8px",borderRight:"1px solid rgba(255,255,255,0.15)",marginRight:6}}>
      <div style={{width:28,height:28,borderRadius:"50%",background:"#0073ea",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800}}>{count}</div>
      <span style={{fontSize:13,color:"#fff",fontWeight:600,whiteSpace:"nowrap"}}>{count===1?"Item":"Items"} selected</span>
    </div>
    {btn(icons.dup,"Duplicate",onDuplicate)}
    <div style={{position:"relative"}}>{btn(icons.move,"Move to",()=>{setMoveOpen(!moveOpen);setStatusOpen(false);setPrioOpen(false);})}{moveOpen&&pop(groups.map(g=>({label:g.name,value:g.id,color:g.color})),v=>{onMove(v);setMoveOpen(false);},()=>setMoveOpen(false))}</div>
    <div style={{position:"relative"}}>{btn(icons.status,"Status",()=>{setStatusOpen(!statusOpen);setMoveOpen(false);setPrioOpen(false);})}{statusOpen&&pop(statuses.map(s=>({label:s,color:SC[s]||"#c4c4c4"})),v=>{onSetStatus(v);setStatusOpen(false);},()=>setStatusOpen(false))}</div>
    <div style={{position:"relative"}}>{btn(icons.prio,"Priority",()=>{setPrioOpen(!prioOpen);setMoveOpen(false);setStatusOpen(false);})}{prioOpen&&pop(priorities.map(p=>({label:p,color:PC[p]||"#c4c4c4"})),v=>{onSetPriority(v);setPrioOpen(false);},()=>setPrioOpen(false))}</div>
    {btn(icons.del,"Delete",onDelete,true)}
    <div style={{width:1,height:30,background:"rgba(255,255,255,0.15)",margin:"0 6px"}}/>
    <div onClick={onDeselect} style={{cursor:"pointer",padding:"6px 8px",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",transition:"background .15s"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.12)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>
  </div>);
};

/* ─── USER MENU PANEL ─── */
const UserMenu=({currentUser,setCurrentUser,onOpenAdmin,onClose,teamMembers,onLogout})=>{
  const ref=useRef();
  const [editingName,setEditingName]=useState(false);
  const [nameVal,setNameVal]=useState(currentUser.name);
  const [tab,setTab]=useState("profile");
  useOutsideClick(ref,onClose);
  const saveName=()=>{if(nameVal.trim()){setCurrentUser(u=>({...u,name:nameVal.trim()}));setEditingName(false);}};
  const ini=Initials(currentUser.name);
  const isAdmin=currentUser.role==="Admin";
  const onlineCount=teamMembers.filter(m=>m.online).length;
  const mi=(icon,label,sub,onClick,danger)=>(<div onClick={onClick} style={{padding:"8px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,borderRadius:6,margin:"0 6px",transition:"background .12s"}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}><span style={{fontSize:16,width:24,textAlign:"center"}}>{icon}</span><div style={{flex:1}}><div style={{fontSize:13,fontWeight:500,color:danger?"#e2445c":"#333"}}>{label}</div>{sub&&<div style={{fontSize:11,color:"#999"}}>{sub}</div>}</div></div>);
  return(<div ref={ref} style={{position:"absolute",top:"calc(100% + 8px)",right:0,background:"#fff",borderRadius:12,boxShadow:"0 12px 48px rgba(0,0,0,.18)",border:"1px solid #e6e9ef",width:300,zIndex:100020,overflow:"hidden"}}>
    <div style={{padding:"16px 18px 12px",background:"linear-gradient(135deg,#f8f7ff,#f0f8ff)",borderBottom:"1px solid #e6e9ef"}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <div style={{width:48,height:48,borderRadius:"50%",background:currentUser.color,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:700,flexShrink:0,position:"relative"}}>
          {ini}
          <div style={{position:"absolute",bottom:0,right:0,width:14,height:14,borderRadius:"50%",background:"#00c875",border:"2.5px solid #fff"}}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          {editingName?<div style={{display:"flex",gap:4}}><input value={nameVal} onChange={e=>setNameVal(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveName();if(e.key==="Escape"){setEditingName(false);setNameVal(currentUser.name);}}} style={{flex:1,border:"1px solid #6c5ce7",borderRadius:4,padding:"3px 8px",fontSize:13,outline:"none"}} autoFocus/><button onClick={saveName} style={{background:"#6c5ce7",border:"none",borderRadius:4,color:"#fff",fontSize:11,padding:"3px 8px",cursor:"pointer"}}>Save</button></div>
          :<div><div onClick={()=>setEditingName(true)} style={{fontSize:15,fontWeight:700,color:"#1a1a2e",cursor:"pointer"}} title="Click to edit name">{currentUser.name} <span style={{fontSize:10,color:"#999"}}>✎</span></div>
            <div style={{fontSize:11,color:"#888"}}>{currentUser.email||"No email set"}</div></div>}
          <span style={{display:"inline-block",marginTop:4,background:ROLE_COLORS[currentUser.role]||"#c4c4c4",color:"#fff",borderRadius:10,padding:"1px 8px",fontSize:10,fontWeight:700}}>{currentUser.role}</span>
        </div>
      </div>
    </div>
    <div style={{display:"flex",borderBottom:"1px solid #f0f0f0"}}>
      {[["profile","Profile"],["appearance","Display"],["team","Team"]].map(([k,l])=>(<button key={k} onClick={()=>setTab(k)} style={{flex:1,padding:"8px 0",border:"none",background:"transparent",cursor:"pointer",fontSize:12,fontWeight:tab===k?700:400,color:tab===k?"#6c5ce7":"#888",borderBottom:tab===k?"2px solid #6c5ce7":"2px solid transparent"}}>{l}</button>))}
    </div>
    <div style={{maxHeight:300,overflowY:"auto"}}>
      {tab==="profile"&&<div style={{padding:"6px 0"}}>
        {mi("📧","Email",currentUser.email||"Not set",()=>{const e=prompt("Enter your email:",currentUser.email||"");if(e!==null)setCurrentUser(u=>({...u,email:e}));})}
        {mi("📍","Status","Set your status",()=>{const s=prompt("Set your status message:",currentUser.statusMsg||"");if(s!==null)setCurrentUser(u=>({...u,statusMsg:s}));})}
        {currentUser.statusMsg&&<div style={{margin:"0 20px 8px",padding:"6px 10px",background:"#f5f6f8",borderRadius:6,fontSize:12,color:"#666"}}>"{currentUser.statusMsg}"</div>}
        <div style={{borderTop:"1px solid #f0f0f0",margin:"4px 0"}}/>
        {mi("🎨","Avatar color","Choose your color",null)}
        <div style={{display:"flex",gap:6,padding:"4px 20px 10px",flexWrap:"wrap"}}>
          {AVATAR_COLORS.map(c=>(<div key={c} onClick={()=>setCurrentUser(u=>({...u,color:c}))} style={{width:24,height:24,borderRadius:"50%",background:c,cursor:"pointer",border:currentUser.color===c?"3px solid #333":"3px solid transparent",transition:"border .12s"}}/>))}
        </div>
      </div>}
      {tab==="appearance"&&<div style={{padding:"6px 0"}}>
        {mi("🔔","Notifications","Toast alerts for changes",()=>setCurrentUser(u=>({...u,notifs:!u.notifs})))}
        <div style={{padding:"2px 20px 8px",display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:12,color:"#888"}}>Enabled</span><Toggle on={currentUser.notifs!==false} onToggle={()=>setCurrentUser(u=>({...u,notifs:!u.notifs}))}/></div>
        {mi("📐","Compact mode","Denser row spacing",()=>setCurrentUser(u=>({...u,compact:!u.compact})))}
        <div style={{padding:"2px 20px 8px",display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:12,color:"#888"}}>Enabled</span><Toggle on={!!currentUser.compact} onToggle={()=>setCurrentUser(u=>({...u,compact:!u.compact}))}/></div>
        {mi("🌙","Dark sidebar","Sidebar theme",()=>setCurrentUser(u=>({...u,darkSidebar:u.darkSidebar===false?true:!(u.darkSidebar!==false)})))}
      </div>}
      {tab==="team"&&<div style={{padding:"6px 0"}}>
        <div style={{padding:"6px 14px 8px",display:"flex",alignItems:"center",justifyContent:"space-between"}}><span style={{fontSize:12,color:"#888"}}>{onlineCount} of {teamMembers.length} online</span>
          {isAdmin&&<button onClick={onOpenAdmin} style={{background:"#6c5ce7",border:"none",borderRadius:6,color:"#fff",padding:"4px 10px",cursor:"pointer",fontSize:11,fontWeight:700}}>Manage Team</button>}</div>
        {teamMembers.slice(0,5).map(m=>{const mi2=Initials(m.name);return(<div key={m.id} style={{padding:"6px 14px",display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:28,height:28,borderRadius:"50%",background:m.color||"#ccc",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,position:"relative",flexShrink:0}}>{mi2}{m.online&&<div style={{position:"absolute",bottom:-1,right:-1,width:10,height:10,borderRadius:"50%",background:"#00c875",border:"2px solid #fff"}}/>}</div>
          <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name}</div><div style={{fontSize:10,color:"#999"}}>{m.online?"Online":m.lastSeen}</div></div>
          <span style={{fontSize:10,color:ROLE_COLORS[m.role],fontWeight:600}}>{m.role}</span>
        </div>);})}
        {teamMembers.length>5&&<div style={{padding:"6px 14px",fontSize:11,color:"#6c5ce7",cursor:"pointer",fontWeight:600}} onClick={onOpenAdmin}>+{teamMembers.length-5} more — View all</div>}
      </div>}
    </div>
    <div style={{borderTop:"1px solid #f0f0f0",padding:"6px 0"}}>
      {isAdmin&&mi("⚙️","Admin Settings","Manage team & permissions",onOpenAdmin)}
      {mi("🚪","Log out","Sign out of your account",()=>{if(confirm("Log out of Slate?")){onLogout();}},true)}
    </div>
  </div>);
};

/* ─── ADMIN PANEL ─── */
const AdminPanel=({teamMembers,setTeamMembers,currentUser,onClose})=>{
  const [addOpen,setAddOpen]=useState(false);
  const [newName,setNewName]=useState("");const [newEmail,setNewEmail]=useState("");const [newRole,setNewRole]=useState("Member");
  const [searchQ,setSearchQ]=useState("");
  const [confirmRemove,setConfirmRemove]=useState(null);
  const isAdmin=currentUser.role==="Admin";
  const filtered=teamMembers.filter(m=>!searchQ||m.name.toLowerCase().includes(searchQ.toLowerCase())||m.email?.toLowerCase().includes(searchQ.toLowerCase()));
  const addMember=()=>{if(!newName.trim())return;const nm={id:uid(),name:newName.trim(),email:newEmail.trim(),role:newRole,color:AVATAR_COLORS[Math.floor(Math.random()*AVATAR_COLORS.length)],online:false,lastSeen:"Invited"};setTeamMembers(t=>[...t,nm]);setNewName("");setNewEmail("");setNewRole("Member");setAddOpen(false);};
  const removeMember=(id)=>{setTeamMembers(t=>t.filter(m=>m.id!==id));setConfirmRemove(null);};
  const changeRole=(id,role)=>{setTeamMembers(t=>t.map(m=>m.id!==id?m:{...m,role}));};
  const onlineCount=teamMembers.filter(m=>m.online).length;
  return(<div style={{position:"fixed",top:0,right:0,bottom:0,width:480,background:"#fff",boxShadow:"-4px 0 32px rgba(0,0,0,.15)",zIndex:100030,display:"flex",flexDirection:"column"}}>
    <div style={{padding:"16px 20px",borderBottom:"1px solid #e6e9ef",display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontSize:22}}>👥</span>
      <div style={{flex:1}}><div style={{fontSize:16,fontWeight:700}}>Team Management</div><div style={{fontSize:12,color:"#888"}}>{teamMembers.length} members · {onlineCount} online</div></div>
      <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#888"}}>✕</button>
    </div>
    <div style={{padding:"10px 16px",borderBottom:"1px solid #f0f0f0",display:"flex",gap:8,alignItems:"center"}}>
      <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Search members..." style={{flex:1,border:"1px solid #e0e0e0",borderRadius:6,padding:"6px 10px",fontSize:13,outline:"none"}}/>
      {isAdmin&&<button onClick={()=>setAddOpen(!addOpen)} style={{background:"#6c5ce7",border:"none",borderRadius:6,color:"#fff",padding:"6px 14px",cursor:"pointer",fontSize:13,fontWeight:700,whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4}}>{addOpen?"Cancel":"+ Add Member"}</button>}
    </div>
    {addOpen&&<div style={{padding:"12px 16px",background:"#f8f7ff",borderBottom:"1px solid #e6e9ef"}}>
      <div style={{fontSize:12,fontWeight:700,color:"#6c5ce7",marginBottom:8}}>New Team Member</div>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Full name" style={{flex:1,border:"1px solid #e0e0e0",borderRadius:6,padding:"6px 10px",fontSize:13,outline:"none"}}/>
        <input value={newEmail} onChange={e=>setNewEmail(e.target.value)} placeholder="Email (optional)" style={{flex:1,border:"1px solid #e0e0e0",borderRadius:6,padding:"6px 10px",fontSize:13,outline:"none"}}/>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <span style={{fontSize:12,color:"#888"}}>Role:</span>
        {ROLES.map(r=>(<button key={r} onClick={()=>setNewRole(r)} style={{padding:"4px 12px",borderRadius:20,border:newRole===r?"2px solid #6c5ce7":"1px solid #e0e0e0",background:newRole===r?"#f0eeff":"#fff",cursor:"pointer",fontSize:12,color:newRole===r?"#6c5ce7":"#666",fontWeight:newRole===r?700:400}}>{r}</button>))}
        <div style={{flex:1}}/>
        <button onClick={addMember} disabled={!newName.trim()} style={{padding:"6px 16px",border:"none",borderRadius:6,background:newName.trim()?"#6c5ce7":"#e0e0e0",color:"#fff",cursor:newName.trim()?"pointer":"default",fontSize:13,fontWeight:700}}>Add</button>
      </div>
    </div>}
    <div style={{flex:1,overflowY:"auto",padding:"0"}}>
      {filtered.map(m=>{
        const isSelf=m.id===currentUser.id;
        const isRemoving=confirmRemove===m.id;
        return(<div key={m.id} style={{padding:"12px 16px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid #f5f5f5",background:isRemoving?"#fff5f5":"transparent"}}>
          <div style={{width:36,height:36,borderRadius:"50%",background:m.color||"#ccc",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,position:"relative",flexShrink:0}}>
            {Initials(m.name)}
            {m.online&&<div style={{position:"absolute",bottom:0,right:0,width:11,height:11,borderRadius:"50%",background:"#00c875",border:"2px solid #fff"}}/>}
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:13,fontWeight:600}}>{m.name}</span>
              {isSelf&&<span style={{background:"#e8f8ef",color:"#00c875",borderRadius:10,padding:"0 6px",fontSize:10,fontWeight:700}}>You</span>}
            </div>
            <div style={{fontSize:11,color:"#999"}}>{m.email||"No email"} · {m.online?"Online":m.lastSeen}</div>
          </div>
          {isAdmin&&!isSelf&&<>
            {isRemoving?<div style={{display:"flex",gap:4,alignItems:"center"}}>
              <span style={{fontSize:11,color:"#e2445c",fontWeight:600}}>Remove?</span>
              <button onClick={()=>removeMember(m.id)} style={{background:"#e2445c",border:"none",borderRadius:4,color:"#fff",padding:"3px 8px",cursor:"pointer",fontSize:11,fontWeight:700}}>Yes</button>
              <button onClick={()=>setConfirmRemove(null)} style={{background:"#f5f6f8",border:"none",borderRadius:4,color:"#666",padding:"3px 8px",cursor:"pointer",fontSize:11}}>No</button>
            </div>
            :<>
              <select value={m.role} onChange={e=>changeRole(m.id,e.target.value)} style={{border:"1px solid #e0e0e0",borderRadius:6,padding:"3px 8px",fontSize:11,color:ROLE_COLORS[m.role],fontWeight:700,cursor:"pointer",outline:"none",background:"#fff"}}>
                {ROLES.map(r=><option key={r} value={r}>{r}</option>)}
              </select>
              <button onClick={()=>setConfirmRemove(m.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#ccc",fontSize:14,padding:2}} title="Remove member">✕</button>
            </>}
          </>}
          {(!isAdmin||isSelf)&&<span style={{fontSize:11,color:ROLE_COLORS[m.role],fontWeight:700,background:"#f5f6f8",borderRadius:10,padding:"2px 8px"}}>{m.role}</span>}
        </div>);
      })}
      {filtered.length===0&&<div style={{textAlign:"center",color:"#ccc",padding:40,fontSize:13}}>No members found</div>}
    </div>
    <div style={{padding:"12px 16px",borderTop:"1px solid #e6e9ef",background:"#f8f9fb"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontSize:11,color:"#888"}}>
          <span style={{fontWeight:600}}>{teamMembers.filter(m=>m.role==="Admin").length}</span> Admins · <span style={{fontWeight:600}}>{teamMembers.filter(m=>m.role==="Member").length}</span> Members · <span style={{fontWeight:600}}>{teamMembers.filter(m=>m.role==="Viewer").length}</span> Viewers
        </div>
        {isAdmin&&<div style={{fontSize:11,color:"#888"}}>Admins can add/remove members & change roles</div>}
      </div>
    </div>
  </div>);
};

/* ─── AUTH SYSTEM ─── */
const AUTH_ADMIN={email:"admin",password:"admin",name:"Admin",role:"Admin"};
const getUsers=()=>{try{return JSON.parse(localStorage.getItem("slate_users")||"[]");}catch(e){return[];}};
const saveUsers=(u)=>{try{localStorage.setItem("slate_users",JSON.stringify(u));}catch(e){}};
const getAuth=()=>{try{const s=localStorage.getItem("slate_auth");return s?JSON.parse(s):null;}catch(e){return null;}};
const saveAuth=(a)=>{try{if(a)localStorage.setItem("slate_auth",JSON.stringify(a));else localStorage.removeItem("slate_auth");}catch(e){}};

const AuthScreen=({onAuth})=>{
  const [mode,setMode]=useState("signin");/* signin | signup | verify */
  const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [confirmPw,setConfirmPw]=useState("");
  const [name,setName]=useState("");const [error,setError]=useState("");const [loading,setLoading]=useState(false);
  const [verifyCode,setVerifyCode]=useState("");const [realCode,setRealCode]=useState("");const [pendingUser,setPendingUser]=useState(null);

  const doSignIn=()=>{
    setError("");
    if(!email.trim()||!password.trim()){setError("Please fill in all fields.");return;}
    /* admin backend */
    if(email.trim().toLowerCase()===AUTH_ADMIN.email&&password===AUTH_ADMIN.password){
      const u={id:"u_admin",name:AUTH_ADMIN.name,email:"admin@slate.app",role:"Admin",color:"#6c5ce7",notifs:true,compact:false,darkSidebar:true,statusMsg:""};
      saveAuth(u);onAuth(u);return;
    }
    /* check registered users */
    const users=getUsers();
    const found=users.find(u=>u.email.toLowerCase()===email.trim().toLowerCase());
    if(!found){setError("No account found with this email.");return;}
    if(found.password!==password){setError("Incorrect password.");return;}
    if(!found.verified){setError("Please verify your email first. Check your inbox.");return;}
    const sess={...found};delete sess.password;
    saveAuth(sess);onAuth(sess);
  };

  const doSignUp=()=>{
    setError("");
    if(!name.trim()||!email.trim()||!password.trim()){setError("Please fill in all fields.");return;}
    if(!email.includes("@")){setError("Please enter a valid email address.");return;}
    if(password.length<4){setError("Password must be at least 4 characters.");return;}
    if(password!==confirmPw){setError("Passwords don't match.");return;}
    const users=getUsers();
    if(users.find(u=>u.email.toLowerCase()===email.trim().toLowerCase())){setError("An account with this email already exists.");return;}
    const code=String(Math.floor(1000+Math.random()*9000));
    const newUser={id:uid(),name:name.trim(),email:email.trim().toLowerCase(),password,role:"Member",color:AVATAR_COLORS[Math.floor(Math.random()*AVATAR_COLORS.length)],verified:false,notifs:true,compact:false,darkSidebar:true,statusMsg:""};
    setPendingUser(newUser);setRealCode(code);setMode("verify");
  };

  const doVerify=()=>{
    setError("");
    if(verifyCode!==realCode){setError("Incorrect code. Please try again.");return;}
    const verified={...pendingUser,verified:true};
    const users=getUsers();users.push(verified);saveUsers(users);
    const sess={...verified};delete sess.password;
    saveAuth(sess);onAuth(sess);
  };

  const doSSO=(provider)=>{
    setError("");setLoading(true);
    setTimeout(()=>{setLoading(false);setError(provider+" SSO is not configured yet. Use email/password or the admin account to sign in.");},1500);
  };

  const inp=(val,set,placeholder,type="text")=>(<input value={val} onChange={e=>set(e.target.value)} placeholder={placeholder} type={type} onKeyDown={e=>{if(e.key==="Enter"){if(mode==="signin")doSignIn();else if(mode==="signup")doSignUp();else doVerify();}}} style={{width:"100%",padding:"12px 16px",border:"1px solid #e0e0e0",borderRadius:8,fontSize:14,outline:"none",boxSizing:"border-box",marginBottom:10,transition:"border .15s"}} onFocus={e=>e.currentTarget.style.borderColor="#6c5ce7"} onBlur={e=>e.currentTarget.style.borderColor="#e0e0e0"}/>);

  const ssoBtn=(icon,label,provider,bg)=>(<button onClick={()=>doSSO(provider)} disabled={loading} style={{flex:1,padding:"10px 12px",border:"1px solid #e0e0e0",borderRadius:8,background:bg||"#fff",cursor:"pointer",fontSize:13,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",gap:8,color:bg?"#fff":"#333",transition:"all .12s"}} onMouseEnter={e=>{e.currentTarget.style.boxShadow="0 2px 8px rgba(0,0,0,.1)";}} onMouseLeave={e=>{e.currentTarget.style.boxShadow="none";}}>{icon}{label}</button>);

  return(<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg,#f0eeff 0%,#e8f4fd 50%,#f0fffe 100%)",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"}}>
    <div style={{width:420,background:"#fff",borderRadius:16,boxShadow:"0 20px 60px rgba(108,92,231,.12)",overflow:"hidden"}}>
      <div style={{padding:"32px 32px 20px",textAlign:"center",background:"linear-gradient(135deg,#6c5ce7,#0984e3)",color:"#fff"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginBottom:8}}><Logo size={36}/><span style={{fontSize:26,fontWeight:800,letterSpacing:1}}>slate</span></div>
        <div style={{fontSize:13,opacity:.8}}>Project Management for Teams</div>
      </div>

      <div style={{padding:"24px 32px 32px"}}>
        {mode!=="verify"&&<div style={{display:"flex",marginBottom:20,background:"#f5f6f8",borderRadius:8,padding:3}}>
          {[["signin","Sign In"],["signup","Sign Up"]].map(([k,l])=>(<button key={k} onClick={()=>{setMode(k);setError("");}} style={{flex:1,padding:"8px 0",border:"none",borderRadius:6,background:mode===k?"#fff":"transparent",color:mode===k?"#6c5ce7":"#888",fontSize:13,fontWeight:mode===k?700:400,cursor:"pointer",boxShadow:mode===k?"0 1px 3px rgba(0,0,0,.08)":"none",transition:"all .15s"}}>{l}</button>))}
        </div>}

        {mode==="signin"&&<div>
          {inp(email,setEmail,"Email or username")}
          {inp(password,setPassword,"Password","password")}
          <button onClick={doSignIn} style={{width:"100%",padding:"12px",border:"none",borderRadius:8,background:"linear-gradient(135deg,#6c5ce7,#0984e3)",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:16,transition:"opacity .15s"}} onMouseEnter={e=>e.currentTarget.style.opacity=.9} onMouseLeave={e=>e.currentTarget.style.opacity=1}>Sign In</button>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}><div style={{flex:1,height:1,background:"#e0e0e0"}}/><span style={{fontSize:11,color:"#999"}}>or continue with</span><div style={{flex:1,height:1,background:"#e0e0e0"}}/></div>
          <div style={{display:"flex",gap:10}}>
            {ssoBtn(<svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>,"Google","Google")}
            {ssoBtn(<svg width="16" height="16" viewBox="0 0 23 23"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg>,"Microsoft","Microsoft")}
          </div>
        </div>}

        {mode==="signup"&&<div>
          {inp(name,setName,"Full name")}
          {inp(email,setEmail,"Email address","email")}
          {inp(password,setPassword,"Password (min 4 chars)","password")}
          {inp(confirmPw,setConfirmPw,"Confirm password","password")}
          <button onClick={doSignUp} style={{width:"100%",padding:"12px",border:"none",borderRadius:8,background:"linear-gradient(135deg,#6c5ce7,#0984e3)",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:10,transition:"opacity .15s"}} onMouseEnter={e=>e.currentTarget.style.opacity=.9} onMouseLeave={e=>e.currentTarget.style.opacity=1}>Create Account</button>
        </div>}

        {mode==="verify"&&<div style={{textAlign:"center"}}>
          <div style={{fontSize:40,marginBottom:12}}>📧</div>
          <div style={{fontSize:16,fontWeight:700,color:"#1a1a2e",marginBottom:6}}>Verify your email</div>
          <div style={{fontSize:13,color:"#888",marginBottom:6}}>We sent a verification code to</div>
          <div style={{fontSize:13,fontWeight:700,color:"#6c5ce7",marginBottom:16}}>{pendingUser?.email}</div>
          <div style={{background:"#f8f5ff",border:"1px dashed #6c5ce7",borderRadius:8,padding:"12px 16px",marginBottom:16,fontSize:13,color:"#6c5ce7"}}>
            <div style={{fontSize:11,color:"#999",marginBottom:4}}>Demo mode — your code is:</div>
            <div style={{fontSize:28,fontWeight:800,letterSpacing:8}}>{realCode}</div>
          </div>
          {inp(verifyCode,setVerifyCode,"Enter 4-digit code")}
          <button onClick={doVerify} style={{width:"100%",padding:"12px",border:"none",borderRadius:8,background:"linear-gradient(135deg,#6c5ce7,#0984e3)",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:10}}>Verify & Sign In</button>
          <button onClick={()=>{setMode("signup");setError("");}} style={{background:"none",border:"none",color:"#888",cursor:"pointer",fontSize:12}}>← Back to Sign Up</button>
        </div>}

        {error&&<div style={{background:"#fff0f0",border:"1px solid #ffd0d0",borderRadius:8,padding:"10px 14px",marginTop:10,fontSize:13,color:"#e2445c",display:"flex",alignItems:"center",gap:8}}><span>⚠</span>{error}</div>}
        {loading&&<div style={{textAlign:"center",padding:16,color:"#6c5ce7",fontSize:13}}>Connecting...</div>}

        {mode==="signin"&&<div style={{textAlign:"center",marginTop:16,fontSize:12,color:"#999"}}>
          <div style={{background:"#f5f6f8",borderRadius:8,padding:"10px 14px",border:"1px solid #e6e9ef"}}>
            <div style={{fontWeight:600,color:"#666",marginBottom:4}}>Demo Admin Account</div>
            <span>Username: <b style={{color:"#333"}}>admin</b></span>{" · "}
            <span>Password: <b style={{color:"#333"}}>admin</b></span>
          </div>
        </div>}
      </div>
    </div>
  </div>);
};

/* ─── SHARE / PERMISSIONS PANEL ─── */
const WsSharePanel=({workspace,teamMembers,onUpdate,onClose})=>{
  const [addEmail,setAddEmail]=useState("");const [addAccess,setAddAccess]=useState("write");
  const shared=workspace?.shared||[];const owner=workspace?.owner||"u_admin";
  const ownerMember=teamMembers.find(m=>m.id===owner);
  const addShare=()=>{if(!addEmail.trim())return;const m=teamMembers.find(t=>t.name.toLowerCase().includes(addEmail.toLowerCase())||t.email?.toLowerCase().includes(addEmail.toLowerCase()));if(!m)return;if(shared.find(s=>s.userId===m.id))return;onUpdate([...shared,{userId:m.id,access:addAccess}]);setAddEmail("");};
  const removeShare=(userId)=>onUpdate(shared.filter(s=>s.userId!==userId));
  const changeAccess=(userId,access)=>onUpdate(shared.map(s=>s.userId!==userId?s:{...s,access}));
  return(<SidePanel title={"🏢 Workspace: "+workspace?.name} sub="Manage workspace access" onClose={onClose} width={420}>
    <div style={{padding:"16px 20px",borderBottom:"1px solid #f0f0f0"}}>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <input value={addEmail} onChange={e=>setAddEmail(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addShare();}} placeholder="Search by name or email..." style={{flex:1,padding:"8px 12px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:13,outline:"none"}}/>
        <select value={addAccess} onChange={e=>setAddAccess(e.target.value)} style={{padding:"8px 10px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:12,outline:"none"}}>
          <option value="write">Can edit</option>
          <option value="read">View only</option>
        </select>
        <button onClick={addShare} style={{padding:"8px 14px",border:"none",borderRadius:6,background:"#6c5ce7",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>Add</button>
      </div>
    </div>
    <div style={{flex:1,overflowY:"auto",padding:0}}>
      <div style={{padding:"12px 20px",fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",letterSpacing:.5}}>Owner</div>
      <div style={{padding:"8px 20px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #f5f5f5"}}>
        <div style={{width:32,height:32,borderRadius:"50%",background:ownerMember?.color||"#6c5ce7",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700}}>{Initials(ownerMember?.name||"Admin")}</div>
        <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{ownerMember?.name||"Admin"}</div><div style={{fontSize:11,color:"#999"}}>{ownerMember?.email||""}</div></div>
        <span style={{fontSize:11,color:"#00c875",fontWeight:700,background:"#e8f8ef",borderRadius:10,padding:"2px 10px"}}>Owner</span>
      </div>
      {shared.length>0&&<div style={{padding:"12px 20px 4px",fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",letterSpacing:.5}}>Members</div>}
      {shared.map(s=>{const m=teamMembers.find(t=>t.id===s.userId);if(!m)return null;return(<div key={s.userId} style={{padding:"10px 20px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #f5f5f5"}}>
        <div style={{width:32,height:32,borderRadius:"50%",background:m.color||"#ccc",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700}}>{Initials(m.name)}</div>
        <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{m.name}</div><div style={{fontSize:11,color:"#999"}}>{m.email||""}</div></div>
        <select value={s.access} onChange={e=>changeAccess(s.userId,e.target.value)} style={{padding:"4px 8px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:11,outline:"none",color:s.access==="write"?"#0073ea":"#888",fontWeight:600}}>
          <option value="write">Can edit</option>
          <option value="read">View only</option>
        </select>
        <span onClick={()=>removeShare(s.userId)} style={{cursor:"pointer",color:"#ccc",fontSize:14}} onMouseEnter={e=>e.currentTarget.style.color="#e2445c"} onMouseLeave={e=>e.currentTarget.style.color="#ccc"}>✕</span>
      </div>);})}
      {shared.length===0&&<div style={{padding:"30px 20px",textAlign:"center",color:"#ccc",fontSize:13}}>No members added yet.</div>}
    </div>
    <div style={{padding:"12px 20px",borderTop:"1px solid #e6e9ef",background:"#f8f9fb",fontSize:11,color:"#888"}}>
      Workspace access controls who can see boards in this workspace.<br/>
      <b>Can edit</b> — create boards, edit all content<br/>
      <b>View only</b> — browse boards, cannot change anything
    </div>
  </SidePanel>);
};

const SharePanel=({board,teamMembers,onUpdate,onClose})=>{
  const [addEmail,setAddEmail]=useState("");const [addAccess,setAddAccess]=useState("write");
  const shared=board?.shared||[];const owner=board?.owner||"u_admin";
  const ownerMember=teamMembers.find(m=>m.id===owner);
  const addShare=()=>{if(!addEmail.trim())return;const m=teamMembers.find(t=>t.name.toLowerCase().includes(addEmail.toLowerCase())||t.email?.toLowerCase().includes(addEmail.toLowerCase()));if(!m){return;}if(shared.find(s=>s.userId===m.id))return;onUpdate([...shared,{userId:m.id,access:addAccess}]);setAddEmail("");};
  const removeShare=(userId)=>onUpdate(shared.filter(s=>s.userId!==userId));
  const changeAccess=(userId,access)=>onUpdate(shared.map(s=>s.userId!==userId?s:{...s,access}));
  return(<SidePanel title={"🔗 Share: "+board?.name} sub="Manage who can access this board" onClose={onClose} width={420}>
    <div style={{padding:"16px 20px",borderBottom:"1px solid #f0f0f0"}}>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <input value={addEmail} onChange={e=>setAddEmail(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addShare();}} placeholder="Search by name or email..." style={{flex:1,padding:"8px 12px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:13,outline:"none"}}/>
        <select value={addAccess} onChange={e=>setAddAccess(e.target.value)} style={{padding:"8px 10px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:12,outline:"none"}}>
          <option value="write">Can edit</option>
          <option value="read">View only</option>
        </select>
        <button onClick={addShare} style={{padding:"8px 14px",border:"none",borderRadius:6,background:"#6c5ce7",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>Share</button>
      </div>
    </div>
    <div style={{flex:1,overflowY:"auto",padding:0}}>
      <div style={{padding:"12px 20px",fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",letterSpacing:.5}}>Owner</div>
      <div style={{padding:"8px 20px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #f5f5f5"}}>
        <div style={{width:32,height:32,borderRadius:"50%",background:ownerMember?.color||"#6c5ce7",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700}}>{Initials(ownerMember?.name||"Admin")}</div>
        <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{ownerMember?.name||"Admin"}</div><div style={{fontSize:11,color:"#999"}}>{ownerMember?.email||""}</div></div>
        <span style={{fontSize:11,color:"#00c875",fontWeight:700,background:"#e8f8ef",borderRadius:10,padding:"2px 10px"}}>Owner</span>
      </div>
      {shared.length>0&&<div style={{padding:"12px 20px 4px",fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",letterSpacing:.5}}>Shared with</div>}
      {shared.map(s=>{const m=teamMembers.find(t=>t.id===s.userId);if(!m)return null;return(<div key={s.userId} style={{padding:"10px 20px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #f5f5f5"}}>
        <div style={{width:32,height:32,borderRadius:"50%",background:m.color||"#ccc",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700}}>{Initials(m.name)}</div>
        <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{m.name}</div><div style={{fontSize:11,color:"#999"}}>{m.email||""}</div></div>
        <select value={s.access} onChange={e=>changeAccess(s.userId,e.target.value)} style={{padding:"4px 8px",border:"1px solid #e0e0e0",borderRadius:6,fontSize:11,outline:"none",color:s.access==="write"?"#0073ea":"#888",fontWeight:600}}>
          <option value="write">Can edit</option>
          <option value="read">View only</option>
        </select>
        <span onClick={()=>removeShare(s.userId)} style={{cursor:"pointer",color:"#ccc",fontSize:14}} onMouseEnter={e=>e.currentTarget.style.color="#e2445c"} onMouseLeave={e=>e.currentTarget.style.color="#ccc"}>✕</span>
      </div>);})}
      {shared.length===0&&<div style={{padding:"30px 20px",textAlign:"center",color:"#ccc",fontSize:13}}>Not shared with anyone yet.<br/>Add team members above.</div>}
    </div>
    <div style={{padding:"12px 20px",borderTop:"1px solid #e6e9ef",background:"#f8f9fb",fontSize:11,color:"#888"}}>
      <b>Can edit</b> — full access to edit rows, groups, and columns<br/>
      <b>View only</b> — can view the board but cannot make changes
    </div>
  </SidePanel>);
};

/* ─── PURE HELPERS (module-level = no recreation per render) ─── */
const _mapGR=(b,gId,fn)=>({...b,groups:b.groups.map(g=>g.id!==gId?g:{...g,rows:fn(g.rows)})});
const _mapAllR=(b,fn)=>({...b,groups:b.groups.map(g=>({...g,rows:fn(g.rows)}))});
const _NO_BULK=new Set(["task","checked","notes","updates","subitems","id","createdAt","lastComment"]);
const _PORD={"Critical":0,"High":1,"Medium":2,"Low":3,"No Priority":4};

export default function App(){
  const [boards,setBoards]=useState(IBOARDS);const [activeId,setActiveId]=useState("b_portfolio");
  const undoRef=useRef([]);const UNDO_MAX=40;
  const snap=useCallback(()=>{setBoards(cur=>{undoRef.current=[...undoRef.current.slice(-(UNDO_MAX-1)),cur];return cur;});},[]);
  const undo=useCallback(()=>{if(!undoRef.current.length)return;const prev=undoRef.current[undoRef.current.length-1];undoRef.current=undoRef.current.slice(0,-1);setBoards(prev);setToast("↩ Undo successful");},[]);
  useEffect(()=>{const h=e=>{if((e.ctrlKey||e.metaKey)&&e.key==="z"&&!e.shiftKey){e.preventDefault();undo();}};document.addEventListener("keydown",h);return()=>document.removeEventListener("keydown",h);},[undo]);
  const [workspaces,setWorkspaces]=useState(INIT_WS);const [activeWs,setActiveWs]=useState("ws_it");const [wsPickerOpen,setWsPickerOpen]=useState(false);
  const [catCol,setCatCol]=useState({"ACTIVE":false,"IN PROGRESS":false,"COMPLETED":true,"STALLED":true,"ON HOLD":true});
  const [people,setPeople]=useState(PEOPLE);const [statuses,setStatuses]=useState(STATS);const [priorities,setPriorities]=useState(PRIS);const [allTags,setAllTags]=useState(TAGS);
  const [autos,setAutos]=useState(()=>{const a={};IBOARDS.forEach(b=>{a[b.id]=[...DEF_AUTOS];});return a;});
  const [autoPanel,setAutoPanel]=useState(false);
  const [activeView,setActiveView]=useState("Main table");
  const [dragRow,setDragRow]=useState(null);const [dragGroup,setDragGroup]=useState(null);const [dragBoardId,setDragBoardId]=useState(null);const [dragOverCat,setDragOverCat]=useState(null);
  const [sideCol,setSideCol]=useState(false);const [rnBoard,setRnBoard]=useState(null);const [rnVal,setRnVal]=useState("");const [editBN,setEditBN]=useState(null);
  const [editDesc,setEditDesc]=useState(false);const [descVal,setDescVal]=useState("");
  const [search,setSearch]=useState("");const [searchOpen,setSearchOpen]=useState(false);
  const [historyOpen,setHistoryOpen]=useState(false);const [histFilter,setHistFilter]=useState("all");const [updPanel,setUpdPanel]=useState(null);const [detailPanel,setDetailPanel]=useState(null);
  const [sortSt,setSortSt]=useState({});const [hovGroup,setHovGroup]=useState(null);
  const [addingWs,setAddingWs]=useState(false);const [newWs,setNewWs]=useState("");
  const [filterOpen,setFilterOpen]=useState(false);const [filters,setFilters]=useState({status:[],owner:[],priority:[],tags:[]});const [globalSortBy,setGlobalSortBy]=useState("Default");const [hiddenCols,setHiddenCols]=useState([]);
  const [expandedSub,setExpandedSub]=useState({});const [ctxMenu,setCtxMenu]=useState(null);
  const [notifsOpen,setNotifsOpen]=useState(false);const [notifs,setNotifs]=useState(NOTIFS);
  const [activityOpen,setActivityOpen]=useState(false);const [templateModal,setTemplateModal]=useState(false);const [toast,setToast]=useState(null);const [confirmDel,setConfirmDel]=useState(null);
  const [resizing,setResizing]=useState(null);const [colCtx,setColCtx]=useState(null);const [syncModal,setSyncModal]=useState(false);const [dragOverBoardId,setDragOverBoardId]=useState(null);const [rnColId,setRnColId]=useState(null);const [rnColVal,setRnColVal]=useState("");const [headerIconOpen,setHeaderIconOpen]=useState(false);
  const [dragCol,setDragCol]=useState(null);const [dragOverCol,setDragOverCol]=useState(null);
  const [ioMenuOpen,setIoMenuOpen]=useState(false);const ioRef=useRef(null);const importRef=useRef(null);const contentRef=useRef(null);
  /* ─── User identity & admin ─── */
  const [authedUser,setAuthedUser]=useState(()=>getAuth());
  const [currentUser,setCurrentUser]=useState(()=>{const a=getAuth();return a||{id:"u_guest",name:"Guest",email:"",role:"Viewer",color:"#c4c4c4",notifs:true,compact:false,darkSidebar:true,statusMsg:""};});
  useEffect(()=>{if(authedUser){setCurrentUser(prev=>{const merged={...prev,...authedUser};try{localStorage.setItem("slate_user",JSON.stringify(merged));}catch(e){}return merged;});}},[authedUser]);
  useEffect(()=>{try{localStorage.setItem("slate_user",JSON.stringify(currentUser));}catch(e){}},[currentUser]);
  const onAuth=(u)=>{setAuthedUser(u);setCurrentUser(u);};
  const onLogout=()=>{saveAuth(null);setAuthedUser(null);setUserMenuOpen(false);};
  const [teamMembers,setTeamMembers]=useState(DEFAULT_TEAM);
  const [userMenuOpen,setUserMenuOpen]=useState(false);
  const [adminOpen,setAdminOpen]=useState(false);
  const [sharePanel,setSharePanel]=useState(false);
  const [wsSharePanel,setWsSharePanel]=useState(false);
  const userMenuRef=useRef(null);
  useEffect(()=>setHeaderIconOpen(false),[activeId]);
  useOutsideClick(ioRef,()=>setIoMenuOpen(false));

  const bi=boards.findIndex(b=>b.id===activeId);const board=boards[bi];const cols=board?.columns||DCOLS;
  const wsBoards=useMemo(()=>boards.filter(b=>b.wsId===activeWs),[boards,activeWs]);
  /* Permission check: board is read-only if user is in shared list with access:"read" and is not owner */
  const boardReadonly=useMemo(()=>{if(!board||!authedUser)return false;if(board.owner===authedUser.id||authedUser.role==="Admin")return false;const s=board.shared?.find(x=>x.userId===authedUser.id);if(s&&s.access==="read")return true;const ws=workspaces.find(w=>w.id===board.wsId);if(ws){if(ws.owner===authedUser.id)return false;const ws_s=ws.shared?.find(x=>x.userId===authedUser.id);if(ws_s&&ws_s.access==="read")return true;}return false;},[board,authedUser,workspaces]);
  const isWk=g=>g.name.toLowerCase().includes("weekly");
  const log=(a,d,c,boardIdOverride,source)=>setBoards(bs=>{const n=[...bs];const targetId=boardIdOverride||activeId;const i=n.findIndex(b=>b.id===targetId);if(i<0)return bs;n[i]={...n[i],hist:[...(n[i].hist||[]),{action:a,detail:d,time:ts(),color:c,source:source||null}]};return n;});
  const logSync=(bId,a,d,c,src)=>{log(a,d,c,bId,src);if(src&&src.includes("Auto-synced"))setToast(d);};
  const setB=(idx,fn,quiet)=>{if(!quiet)snap();setBoards(bs=>{const n=[...bs];n[idx]=fn(n[idx]);return n;});};
  /* Helper: update active board with optional auto-sync */
  const updActive=useCallback((fn,doSync,quiet)=>{if(!quiet)snap();setBoards(bs=>{let n=[...bs];const i=n.findIndex(b=>b.id===activeId);if(i<0)return bs;n[i]=fn(n[i]);if(doSync&&!n[i].isMain&&(n[i].linkedMainBoardId||n[i].syncTargets?.length))n=syncBoards(n,activeId,logSync);return n;});},[activeId,snap]);
  /* _mapGR/mapAllR moved to module level as _mapGR/_mapAllR */


  const runAutos=useCallback((f,v,row,gId)=>{
    (autos[activeId]||[]).filter(a=>a.enabled).forEach(a=>{
      if(a.trigger==="status_done"&&f==="status"&&v==="Done"){
        setB(bi,b=>({...b,groups:b.groups.map(g=>g.id!==gId?g:{...g,rows:g.rows.map(r=>r.id!==row.id?r:{...r,completionDate:today(),completionStatus:"Done On Time"})})}));
        log("Auto","Completion date set for \""+row.task+"\"","#00c875");
      }
      if(a.trigger==="status_done_move"&&f==="status"&&v==="Done"){
        setB(bi,b=>{const gs=[...b.groups];const lastG=gs[gs.length-1];if(!lastG||lastG.id===gId)return b;let moved;const ng=gs.map(g=>{if(g.id!==gId)return g;moved=g.rows.find(r=>r.id===row.id);return{...g,rows:g.rows.filter(r=>r.id!==row.id)};});if(!moved)return b;ng[ng.length-1]={...ng[ng.length-1],rows:[...ng[ng.length-1].rows,moved]};return{...b,groups:ng};});
        log("Auto","\""+row.task+"\" moved to last group","#a25ddc");
      }
      if(a.trigger==="owner_set"&&f==="owner"&&v){
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,updates:[...(r.updates||[]),mkU("Assigned to "+v,"Automation")]})));
        log("Auto","Assignment update added for \""+row.task+"\"","#579bfc");
      }
      if(a.trigger==="status_stuck_notify"&&f==="status"&&v==="Stuck"){
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,updates:[...(r.updates||[]),mkU("⚠ Item is now STUCK — needs attention","Automation")],priority:r.priority==="Low"||r.priority==="No Priority"?"High":r.priority})));
        log("Auto","Stuck alert added for \""+row.task+"\"","#e2445c");
      }
      if(a.trigger==="status_progress_date"&&f==="status"&&(v==="In Progress"||v==="Working on it")&&!row.tlStart){
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,tlStart:today()})));
        log("Auto","Start date set for \""+row.task+"\"","#579bfc");
      }
      if(a.trigger==="subitems_done"&&f==="status"&&row.subitems?.length>0){
        const allDone=row.subitems.every(s=>s.status==="Done");
        if(allDone&&row.status!=="Done"){
          setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,status:"Done",completionDate:today()})));
          log("Auto","All subitems done → \""+row.task+"\" marked Done","#00c875");
        }
      }
      if(a.trigger==="item_created_priority"&&f==="__created"){
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,priority:"Medium"})));
        log("Auto","Priority set to Medium for new item","#fdab3d");
      }
      if(a.trigger==="item_created_assign"&&f==="__created"&&currentUser?.name){
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,owner:currentUser.name})));
        log("Auto","Auto-assigned to "+currentUser.name,"#579bfc");
      }
      if(a.trigger==="item_created_duedate"&&f==="__created"){
        const d=new Date();d.setDate(d.getDate()+7);const due=d.toISOString().split("T")[0];
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,tlEnd:due})));
        log("Auto","Due date set to "+due+" for new item","#579bfc");
      }
      if(a.trigger==="edit_start"&&f==="task"&&v&&row.status==="Not Started"){
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,status:"In Progress"})));
        log("Auto","\""+v+"\" auto-started on edit","#0073ea");
      }
      if(a.trigger==="email_done"&&f==="status"&&v==="Done"){
        setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==row.id?r:{...r,updates:[...(r.updates||[]),mkU("✅ Completion logged for email digest — "+today(),"Automation")]})));
        log("Auto","Completion logged for \""+row.task+"\"","#00c875");
      }
    });
  },[autos,activeId,bi,currentUser]);

  /* ─── Date-based automations — run every 60s (uses ref to avoid infinite loop) ─── */
  const boardsRef=useRef(boards);boardsRef.current=boards;
  const biRef=useRef(bi);biRef.current=bi;
  useEffect(()=>{
    const run=()=>{
      const ba=autos[activeId]||[];if(!ba.some(a=>a.enabled&&(a.trigger==="date_passed"||a.trigger==="deadline_reminder"||a.trigger==="recurring_weekly")))return;
      const curBi=biRef.current;const b=boardsRef.current[curBi];if(!b||b.isMain||b.isDashboard||b.isSummary)return;
      let changed=false;const td=today();
      const nb={...b,groups:b.groups.map(g=>({...g,rows:g.rows.map(r=>{
        const upd={};
        if(ba.find(a=>a.enabled&&a.trigger==="date_passed")&&r.tlEnd&&r.status!=="Done"&&r.status!=="Stuck"&&new Date(r.tlEnd)<new Date(td)){
          upd.status="Stuck";upd.updates=[...(r.updates||[]),mkU("⏰ Auto-set to Stuck — past due date "+r.tlEnd,"Automation")];changed=true;
        }
        if(ba.find(a=>a.enabled&&a.trigger==="deadline_reminder")&&r.tlEnd&&r.status!=="Done"&&r.priority!=="High"&&r.priority!=="Critical"){
          const d=daysDiff(r.tlEnd);if(d>=0&&d<=3){upd.priority="High";upd.updates=[...(r.updates||upd.updates||[]),mkU("📅 Deadline in "+d+" days — priority raised","Automation")];changed=true;}
        }
        return Object.keys(upd).length?{...r,...upd}:r;
      })}))};
      if(ba.find(a=>a.enabled&&a.trigger==="recurring_weekly")&&nb.groups.length>0){
        const fg=nb.groups[0];const hasToday=fg.rows.some(r=>r.task&&r.task.includes("Weekly Standup")&&r.task.includes(td));
        if(!hasToday&&new Date().getDay()===1){nb.groups[0]={...fg,rows:[mk({task:"Weekly Standup — "+td,owner:"",status:"Not Started",priority:"Medium",tlStart:td,tlEnd:td,tags:["Review"]}),...fg.rows]};changed=true;}
      }
      if(changed){snap();setBoards(bs=>{const n=[...bs];n[curBi]=nb;return n;});log("Auto","Date-based automations ran","#fdab3d");}
    };
    run();const iv=setInterval(run,60000);return()=>clearInterval(iv);
  },[autos,activeId,snap]);

  /* NO_BULK moved to module level as _NO_BULK */
  const upRow=(gId,rId,f,v)=>{if(boardReadonly&&f!=="checked")return;const grp=board.groups.find(g=>g.id===gId);const row=grp?.rows.find(r=>r.id===rId);
    const applyBulk=row?.checked&&selCount>1&&!_NO_BULK.has(f);
    const sel=applyBulk?new Set(selectedRows.map(s=>s.rId)):null;
    const needsSync=f==="status"||f==="weeklyUpdate"||f==="weeklyStatus";
    const quiet=f==="checked";
    updActive(b=>applyBulk?_mapAllR(b,rs=>rs.map(r=>sel.has(r.id)?{...r,[f]:v}:r)):_mapGR(b,gId,rs=>rs.map(r=>r.id!==rId?r:{...r,[f]:v})),needsSync,quiet);
    if(applyBulk){log("Bulk "+f,selCount+" items → "+String(v),"#0073ea");}
    else if(f==="status"){log("Status","\""+((row?.task)||"")+"\" → "+v,"#00c875");runAutos(f,v,row,gId);}
    else if(f==="owner"||f==="task"){runAutos(f,v,row,gId);}
  };
  const addRow=useCallback(gId=>{if(boardReadonly)return;const nr=mk();updActive(b=>_mapGR(b,gId,rs=>[...rs,nr]),true);log("Row","Added","#579bfc");runAutos("__created","",nr,gId);},[updActive,boardReadonly,runAutos]);
  const delRow=useCallback((gId,rId)=>{if(boardReadonly)return;updActive(b=>_mapGR(b,gId,rs=>rs.filter(r=>r.id!==rId)),true);},[updActive,boardReadonly]);
  const dupRow=(gId,rId)=>{const grp=board.groups.find(g=>g.id===gId);const row=grp?.rows.find(r=>r.id===rId);if(row){const nr={...row,id:uid(),task:row.task+" (copy)",subitems:(row.subitems||[]).map(s=>({...s,id:uid()})),updates:[]};setB(bi,b=>({...b,groups:b.groups.map(g=>g.id!==gId?g:{...g,rows:[...g.rows,nr]})}));}};
  /* --- Bulk selection helpers --- */
  const selectedRows=useMemo(()=>{if(!board)return[];const sel=[];board.groups.forEach(g=>{g.rows.forEach(r=>{if(r.checked&&!r._syncReadonly)sel.push({gId:g.id,rId:r.id,task:r.task});});});return sel;},[board]);
  const selCount=selectedRows.length;
  const deselectAll=()=>setB(bi,b=>({...b,groups:b.groups.map(g=>({...g,rows:g.rows.map(r=>({...r,checked:false}))}))}),true);
  const selectAllInGroup=(gId,val)=>setB(bi,b=>({...b,groups:b.groups.map(g=>g.id!==gId?g:{...g,rows:g.rows.map(r=>r._syncReadonly?r:{...r,checked:val})})}),true);
  const bulkDelete=()=>{const sel=new Set(selectedRows.map(s=>s.rId));updActive(b=>_mapAllR(b,rs=>rs.filter(r=>!sel.has(r.id))),true);log("Bulk Delete",selCount+" items deleted","#e2445c");};
  const bulkDuplicate=()=>{const sel=new Set(selectedRows.map(s=>s.rId));setB(bi,b=>_mapAllR(b,rs=>{const dups=rs.filter(r=>sel.has(r.id)).map(r=>({...r,id:uid(),task:r.task+" (copy)",checked:false,subitems:(r.subitems||[]).map(s=>({...s,id:uid()})),updates:[]}));return[...rs.map(r=>sel.has(r.id)?{...r,checked:false}:r),...dups];}));log("Bulk Duplicate",selCount+" items duplicated","#579bfc");};
  const bulkMove=(toGId)=>{const sel=new Set(selectedRows.map(s=>s.rId));setB(bi,b=>{let moved=[];const gs=b.groups.map(g=>{const mv=g.rows.filter(r=>sel.has(r.id));moved=moved.concat(mv.map(r=>({...r,checked:false})));return{...g,rows:g.rows.filter(r=>!sel.has(r.id))};});return{...b,groups:gs.map(g=>g.id!==toGId?g:{...g,rows:[...g.rows,...moved]})};});log("Bulk Move",selCount+" items moved","#fdab3d");};
  const bulkSetStatus=(status)=>{const sel=new Set(selectedRows.map(s=>s.rId));const autoComplete=(autos[activeId]||[]).some(a=>a.enabled&&a.trigger==="status_done");updActive(b=>_mapAllR(b,rs=>rs.map(r=>sel.has(r.id)?{...r,status,checked:false,...(status==="Done"&&autoComplete?{completionDate:today(),completionStatus:"Done On Time"}:{})}:r)),true);log("Bulk Status",selCount+" items → "+status,"#00c875");};
  const bulkSetPriority=(priority)=>{const sel=new Set(selectedRows.map(s=>s.rId));setB(bi,b=>_mapAllR(b,rs=>rs.map(r=>sel.has(r.id)?{...r,priority,checked:false}:r)));log("Bulk Priority",selCount+" items → "+priority,"#fdab3d");};
  const addGroup=()=>{setB(bi,b=>({...b,groups:[...b.groups,{id:uid(),name:"New Group",color:CL[b.groups.length%CL.length],collapsed:false,rows:[]}]}));};
  const togGroup=gId=>setB(bi,b=>({...b,groups:b.groups.map(g=>g.id!==gId?g:{...g,collapsed:!g.collapsed})}),true);
  const rnGroup=(gId,n)=>setB(bi,b=>({...b,groups:b.groups.map(g=>g.id!==gId?g:{...g,name:n})}));
  const delGroup=gId=>setB(bi,b=>({...b,groups:b.groups.filter(g=>g.id!==gId)}));
  const setCols=fn=>setB(bi,b=>({...b,columns:fn(b.columns)}));
  const reorderCol=(fromId,toId)=>{if(fromId===toId)return;setCols(c=>{const n=[...c];const fi=n.findIndex(x=>x.id===fromId);if(fi<0)return c;const[moved]=n.splice(fi,1);const ti=n.findIndex(x=>x.id===toId);if(ti<0){n.push(moved);}else{n.splice(ti,0,moved);}return n;});};
  const addColAfter=(aid,type,label)=>{const id=uid();setCols(c=>{const n=[...c];const newCol={id,name:label,type,w:type==="timeline"?180:120};if(type==="dropdown")newCol.labels=["Option 1","Option 2","Option 3"];if(aid==="__START__"){n.splice(0,0,newCol);}else if(aid){const i=n.findIndex(x=>x.id===aid);n.splice(i+1,0,newCol);}else n.push(newCol);return n;});};
  const delCol=cid=>setCols(c=>c.filter(x=>x.id!==cid));
  const rnCol=(cid,newName)=>setCols(c=>c.map(x=>x.id!==cid?x:{...x,name:newName}));
  const hideCol=colName=>setHiddenCols(h=>h.includes(colName)?h:[...h,colName]);
  const addSyncTarget=(targetBoardId)=>{
    snap();setBoards(bs=>{let n=[...bs];const i=n.findIndex(b=>b.id===activeId);if(i<0)return bs;
      const existing=n[i].syncTargets||[];if(existing.some(s=>s.boardId===targetBoardId))return bs;
      n[i]={...n[i],syncTargets:[...existing,{boardId:targetBoardId}]};return syncBoards(n,activeId,logSync);});
    log("Sync","Connected to board","#a25ddc");
  };
  const removeSyncTarget=(targetBoardId)=>{
    snap();setBoards(bs=>bs.map(b=>b.id!==activeId?b:{...b,syncTargets:(b.syncTargets||[]).filter(s=>s.boardId!==targetBoardId)}));
  };
  const COL_TYPES=[
    {type:"text",icon:"Aa",label:"Text"},{type:"number",icon:"#",label:"Numbers"},
    {type:"status",icon:"●",label:"Status"},{type:"person",icon:"👤",label:"People"},
    {type:"priority",icon:"◆",label:"Priority"},{type:"dropdown",icon:"▾",label:"Dropdown"},
    {type:"tags",icon:"🏷",label:"Tags"},{type:"timeline",icon:"📅",label:"Timeline"},
    {type:"timer",icon:"⏱",label:"Time Tracking"},{type:"date",icon:"📆",label:"Date"},
    {type:"link",icon:"🔗",label:"Link"},{type:"checkbox",icon:"☑",label:"Checkbox"},
  ];
  const addUpdate=(gId,rId,text)=>{setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==rId?r:{...r,updates:[...(r.updates||[]),mkU(text,currentUser.name)]})));log("Update","\""+text.slice(0,30)+"\"","#0073ea");};
  const addSubitem=(gId,rId)=>setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==rId?r:{...r,subitems:[...(r.subitems||[]),mkSub()]})));
  const upSubitem=(gId,rId,siId,f,v)=>setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==rId?r:{...r,subitems:(r.subitems||[]).map(si=>si.id!==siId?si:{...si,[f]:v})})));
  const delSubitem=(gId,rId,siId)=>setB(bi,b=>_mapGR(b,gId,rs=>rs.map(r=>r.id!==rId?r:{...r,subitems:(r.subitems||[]).filter(si=>si.id!==siId)})));
  const saveBN=(id,n)=>{snap();setBoards(bs=>bs.map(b=>b.id===id?{...b,name:n||b.name}:b));};
  const saveDesc=(id,d)=>{snap();setBoards(bs=>bs.map(b=>b.id===id?{...b,desc:d}:b));};
  const saveIcon=(id,ic)=>{snap();setBoards(bs=>bs.map(b=>b.id===id?{...b,icon:ic}:b));};
  const changeSummarySrc=(src)=>{setBoards(bs=>bs.map(b=>b.id===activeId?{...b,summarySrc:src}:b));};
  const dupBoard=(bId)=>{const src=boards.find(b=>b.id===bId);if(!src)return;snap();const nb={...JSON.parse(JSON.stringify(src)),id:uid(),name:src.name+" (copy)"};nb.groups.forEach(g=>{g.id=uid();g.rows.forEach(r=>{r.id=uid();(r.subitems||[]).forEach(s=>{s.id=uid();});});});setBoards(bs=>[...bs,nb]);setActiveId(nb.id);};
  const moveBoardCat=(bId,cat)=>{snap();setBoards(bs=>bs.map(b=>b.id===bId?{...b,cat}:b));};
  const addBoardFromTemplate=(tmpl)=>{snap();const nb={id:uid(),name:tmpl.name,desc:tmpl.isDashboard?"Cross-board analytics dashboard":tmpl.isSummary?"Executive summary — VP quick view":"",cat:tmpl.folder||"ACTIVE",wsId:activeWs,icon:tmpl.icon,isMain:false,isDashboard:!!tmpl.isDashboard,isSummary:!!tmpl.isSummary,summarySrc:"all",hist:[],columns:cloneCols(DCOLS),groups:tmpl.groups.map(g=>({id:uid(),name:g.name,color:g.color,collapsed:false,rows:[]}))};if(tmpl.linked&&tmpl.linkTo){nb.linkedMainBoardId=tmpl.linkTo;nb.linkedMainItemName=tmpl.linkItem||"";}setBoards(bs=>[...bs,nb]);setActiveId(nb.id);setTemplateModal(false);};

  /* ─── Import / Export handlers ─── */
  const handleExportExcel=()=>{if(!board)return;setIoMenuOpen(false);exportBoardToExcel(board);setToast("📥 Exported \""+board.name+"\"");};
  const handleExportDashExcel=()=>{setIoMenuOpen(false);exportDashboardToExcel(boards);setToast("📥 Dashboard exported");};
  const handleExportSummaryExcel=()=>{setIoMenuOpen(false);exportSummaryToExcel(boards,board?.summarySrc||"all");setToast("📥 Executive Summary exported");};
  const handleExportPDF=()=>{
    setIoMenuOpen(false);
    if(!contentRef.current)return;
    const clone=contentRef.current.cloneNode(true);
    const win=window.open("","_blank","width=1100,height=800");
    if(!win){setToast("⚠ Pop-up blocked — please allow pop-ups and try again");return;}
    win.document.write("<!DOCTYPE html><html><head><title>"+(board?.name||"Export")+" — Slate</title>");
    win.document.write("<style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter','Segoe UI',system-ui,sans-serif;}");
    win.document.write("body{padding:32px 24px;background:#fff;color:#333;-webkit-print-color-adjust:exact;print-color-adjust:exact;}");
    win.document.write(".hdr{display:flex;align-items:center;gap:12px;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #e6e9ef;}");
    win.document.write(".hdr h1{font-size:22px;font-weight:700;}.hdr .sub{font-size:12px;color:#888;}");
    win.document.write("@media print{body{padding:16px;}@page{size:landscape;margin:12mm;}}");
    win.document.write("</style></head><body>");
    win.document.write("<div class='hdr'><h1>"+(board?.icon||"📋")+" "+(board?.name||"Board")+"</h1><div class='sub'>Exported "+new Date().toLocaleDateString()+"</div></div>");
    clone.style.overflow="visible";clone.style.maxHeight="none";clone.style.height="auto";
    win.document.body.appendChild(clone);
    win.document.write("</body></html>");
    win.document.close();
    setTimeout(()=>{win.focus();win.print();},400);
    setToast("📄 PDF print dialog opened");
  };
  const handleImport=()=>{setIoMenuOpen(false);importRef.current?.click();};
  const onImportFile=(e)=>{
    const file=e.target.files?.[0];if(!file)return;
    parseImportFile(file,function(groups,err){
      if(err||!groups||!groups.length){setToast("⚠ Import failed"+(err?" — "+err:""));return;}
      snap();
      const name=file.name.replace(/\.[^.]+$/,"");
      const total=groups.reduce((a,g)=>a+g.rows.length,0);
      const nb={id:uid(),name,desc:"Imported from "+file.name,cat:"ACTIVE",wsId:activeWs,icon:"📥",isMain:false,isDashboard:false,isSummary:false,summarySrc:"all",hist:[{action:"Board imported",detail:total+" items from "+file.name,time:ts(),color:"#00c875"}],columns:cloneCols(DCOLS),groups:groups};
      setBoards(bs=>[...bs,nb]);setActiveId(nb.id);setToast("✅ Imported \""+name+"\" — "+total+" items");
    });
    e.target.value="";
  };

  const onResizeStart=(e,colId)=>{e.preventDefault();e.stopPropagation();const startX=e.clientX;const startCols=[...(board?.columns||DCOLS)];const col=startCols.find(c=>c.id===colId);const startW=col?.w||120;const onMove=ev=>{const diff=ev.clientX-startX;const nw=Math.max(50,startW+diff);setCols(cs=>cs.map(c=>c.id!==colId?c:{...c,w:nw}));};const onUp=()=>{document.removeEventListener("mousemove",onMove);document.removeEventListener("mouseup",onUp);setResizing(null);};setResizing(colId);document.addEventListener("mousemove",onMove);document.addEventListener("mouseup",onUp);};
  const onResizeDblClick=(colId)=>{const defaults={task:220,owner:100,status:130,priority:130,timeline:200,tags:120,duration:90,timer:110,updates:60,weeklyStatus:260,progress:150,weeklyUpdate:230,linkedBoard:130,tltype:130,customer:130,team:110};setCols(cs=>cs.map(c=>c.id!==colId?c:{...c,w:defaults[colId]||140}));};

  const doSort=(gId,colId,dir)=>{if(!dir){setSortSt(s=>{const n={...s};delete n[gId];return n;});return;}setSortSt(s=>({...s,[gId]:{colId,dir}}));};
  const processRows=useCallback((rows,gId)=>{
    const f=filters,s=search?search.toLowerCase():null;
    let r=rows.filter(x=>{
      if(f.status.length&&!f.status.includes(x.status))return false;
      if(f.owner.length&&!f.owner.includes(x.owner))return false;
      if(f.priority.length&&!f.priority.includes(x.priority))return false;
      if(f.tags.length&&!(x.tags||[]).some(t=>f.tags.includes(t)))return false;
      if(s)return Object.values(x).some(v=>Array.isArray(v)?v.some(z=>typeof z==="string"?z.toLowerCase().includes(s):z?.text?.toLowerCase().includes(s)):String(v).toLowerCase().includes(s));
      return true;
    });
    const ss=sortSt[gId];
    if(ss?.dir)r=[...r].sort((a,b)=>{let va=String(a[ss.colId==="timeline"?"tlStart":ss.colId]||"").toLowerCase(),vb=String(b[ss.colId==="timeline"?"tlStart":ss.colId]||"").toLowerCase();return ss.dir==="asc"?(va<vb?-1:va>vb?1:0):(va>vb?-1:va<vb?1:0);});
    if(globalSortBy&&globalSortBy!=="Default"){
      r=[...r].sort((a,b)=>globalSortBy==="Name"?(a.task||"").localeCompare(b.task||""):globalSortBy==="Status"?(a.status||"").localeCompare(b.status||""):globalSortBy==="Priority"?(_PORD[a.priority]||4)-(_PORD[b.priority]||4):globalSortBy==="Owner"?(a.owner||"").localeCompare(b.owner||""):0);
    }
    return r;
  },[filters,search,sortSt,globalSortBy]);

  const allRows=useMemo(()=>{if(!board)return[];const ar=[];board.groups.forEach(g=>g.rows.forEach(r=>ar.push({row:r,gId:g.id})));return ar;},[board]);
  const filteredAllRows=useMemo(()=>{const f=filters;return allRows.filter(({row:x})=>(!f.status.length||f.status.includes(x.status))&&(!f.owner.length||f.owner.includes(x.owner))&&(!f.priority.length||f.priority.includes(x.priority))&&(!f.tags.length||(x.tags||[]).some(t=>f.tags.includes(t))));},[allRows,filters]);

  const boardAutos=useMemo(()=>autos[activeId]||[],[autos,activeId]);
  const getGCols=useCallback(g=>{let c=cols;if(isWk(g)){const has=c.find(x=>x.id==="weeklyStatus");if(!has)c=[...c,{id:"weeklyStatus",name:"Weekly Status",type:"weeklyStatus",w:250}];}if(hiddenCols.length>0)c=c.filter(x=>!hiddenCols.includes(x.name));return c;},[cols,hiddenCols]);
  const onRowDrop=(e,toG,toR)=>{if(e.currentTarget&&e.currentTarget.style){e.currentTarget.style.borderTop="";e.currentTarget.style.background="";}if(!dragRow)return;setB(bi,b=>{let row;const gs=b.groups.map(g=>{if(g.id===dragRow.gId){row=g.rows.find(r=>r.id===dragRow.rId);return({...g,rows:g.rows.filter(r=>r.id!==dragRow.rId)});}return g;});if(!row)return b;return({...b,groups:gs.map(g=>{if(g.id!==toG)return g;const i=g.rows.findIndex(r=>r.id===toR);const nr=[...g.rows];nr.splice(i===-1?nr.length:i,0,row);return({...g,rows:nr});})});});setDragRow(null);};
  const onGDrop=(e,toG)=>{if(e.currentTarget&&e.currentTarget.style){e.currentTarget.style.borderTop="";}if(!dragGroup||dragGroup===toG)return;setB(bi,b=>{const gs=[...b.groups];const fi=gs.findIndex(g=>g.id===dragGroup);const ti=gs.findIndex(g=>g.id===toG);const[m]=gs.splice(fi,1);gs.splice(ti,0,m);return({...b,groups:gs});});setDragGroup(null);};

  let detailRow=null,detailGId=null;if(detailPanel){board?.groups.forEach(g=>{const r=g.rows.find(r2=>r2.id===detailPanel.rId);if(r){detailRow=r;detailGId=g.id;}});}
  let updRow=null;if(updPanel){const g=board?.groups.find(g2=>g2.id===updPanel.gId);updRow=g?.rows.find(r=>r.id===updPanel.rId);}
  const unreadCount=useMemo(()=>notifs.filter(n=>!n.read).length,[notifs]);
  const histBadge=useMemo(()=>boards.reduce((a,b)=>(a+(b.hist||[]).length),0),[boards]);
  const histItems=useMemo(()=>boards.filter(b=>histFilter==="all"||b.id===histFilter).flatMap(b=>(b.hist||[]).map(h=>({...h,board:b.name,boardId:b.id}))),[boards,histFilter]);

  const SyncBanner=useCallback(({icon,title,sub,pill,pillBg})=>(<div style={{background:"linear-gradient(90deg,#f0f0ff,#f0fffe)",border:"1px solid #d8d4ff",borderRadius:8,padding:"10px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10,fontSize:13,flexWrap:"wrap"}}><span style={{fontWeight:600}}>{icon} {title}</span><span style={{color:"#888"}}>{sub}</span>{pill&&<span style={{marginLeft:"auto",background:pillBg||"linear-gradient(135deg,#6c5ce7,#0984e3)",color:"#fff",borderRadius:20,padding:"2px 12px",fontSize:11,fontWeight:700}}>{pill}</span>}</div>),[]);

  if(!authedUser) return (<AuthScreen onAuth={onAuth}/>);

  return(
    <div style={{fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",height:"100vh",display:"flex",background:"#f6f7fb",userSelect:resizing?"none":"auto"}}>
      <div style={{width:sideCol?48:260,background:"#292f4c",color:"#fff",display:"flex",flexDirection:"column",flexShrink:0,transition:"width .2s",overflow:"hidden"}}>
        <div style={{padding:"14px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid rgba(255,255,255,.1)"}}><div onClick={()=>setSideCol(!sideCol)} style={{cursor:"pointer",flexShrink:0}}><Logo size={30}/></div>{!sideCol&&<span style={{fontSize:17,fontWeight:700}}>slate</span>}</div>
        {!sideCol&&<div style={{display:"contents"}}>
          <div style={{padding:"10px 12px",borderBottom:"1px solid rgba(255,255,255,.08)"}}>
            <div onClick={()=>setWsPickerOpen(!wsPickerOpen)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"rgba(255,255,255,.08)",borderRadius:8,cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,.12)"} onMouseLeave={e=>e.currentTarget.style.background="rgba(255,255,255,.08)"}>
              <span style={{fontSize:16}}>{workspaces.find(w=>w.id===activeWs)?.icon||"📁"}</span>
              <div style={{flex:1}}><div style={{fontSize:14,fontWeight:700}}>{workspaces.find(w=>w.id===activeWs)?.name||"Workspace"}</div><div style={{fontSize:10,color:"rgba(255,255,255,.4)"}}>Workspace</div></div>
              <span style={{fontSize:10,color:"rgba(255,255,255,.4)",transform:wsPickerOpen?"rotate(180deg)":"",transition:"transform .15s"}}>▼</span>
            </div>
            {wsPickerOpen&&<div style={{marginTop:4,background:"rgba(0,0,0,.25)",borderRadius:8,overflow:"hidden"}}>
              {workspaces.map(ws=>(<div key={ws.id} onClick={()=>{setActiveWs(ws.id);setWsPickerOpen(false);const fb=boards.find(b=>b.wsId===ws.id);if(fb)setActiveId(fb.id);}} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",cursor:"pointer",background:ws.id===activeWs?"rgba(87,155,252,.2)":"transparent",borderLeft:ws.id===activeWs?"3px solid #579bfc":"3px solid transparent"}} onMouseEnter={e=>{if(ws.id!==activeWs)e.currentTarget.style.background="rgba(255,255,255,.05)";}} onMouseLeave={e=>{e.currentTarget.style.background=ws.id===activeWs?"rgba(87,155,252,.2)":"transparent";}}>
                <span>{ws.icon}</span><span style={{fontSize:13,fontWeight:ws.id===activeWs?700:400}}>{ws.name}</span>{ws.id===activeWs&&<span style={{marginLeft:"auto",color:"#579bfc",fontSize:10}}>●</span>}
              </div>))}
              {addingWs?<div style={{padding:"6px 10px"}}><input value={newWs} onChange={e=>setNewWs(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&newWs.trim()){const nw={id:uid(),name:newWs.trim(),icon:"📁"};setWorkspaces(w=>[...w,nw]);setActiveWs(nw.id);setNewWs("");setAddingWs(false);setWsPickerOpen(false);}}} onBlur={()=>setAddingWs(false)} placeholder="Name..." style={{width:"100%",background:"rgba(255,255,255,.1)",border:"none",color:"#fff",borderRadius:4,padding:"6px 8px",fontSize:12,outline:"none",boxSizing:"border-box"}} autoFocus/></div>
              :<div style={{display:"flex",borderTop:"1px solid rgba(255,255,255,.06)"}}>
                <div onClick={()=>setAddingWs(true)} style={{flex:1,padding:"8px 12px",fontSize:12,color:"rgba(255,255,255,.4)",cursor:"pointer"}}>+ New workspace</div>
                <div onClick={()=>{setWsSharePanel(true);setWsPickerOpen(false);}} style={{padding:"8px 12px",fontSize:12,color:"rgba(255,255,255,.4)",cursor:"pointer",borderLeft:"1px solid rgba(255,255,255,.06)"}} onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,.7)"} onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,.4)"}>👥 Share</div>
              </div>}
            </div>}
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"6px 0"}}>
            {BOARD_CATS.map(cat=>{const cb=wsBoards.filter(b=>b.cat===cat);const ic=catCol[cat];const isDragOver=dragOverCat===cat;
              return(<div key={cat} style={{marginBottom:2}}
                onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect="move";setDragOverCat(cat);}}
                onDragLeave={()=>setDragOverCat(null)}
                onDrop={e=>{e.preventDefault();setDragOverCat(null);if(dragBoardId){moveBoardCat(dragBoardId,cat);setDragBoardId(null);}}}>
                <div onClick={()=>setCatCol(c=>({...c,[cat]:!c[cat]}))} style={{padding:"6px 14px",display:"flex",alignItems:"center",gap:7,cursor:"pointer",background:isDragOver?"rgba(87,155,252,.2)":"transparent",borderRadius:isDragOver?4:0,transition:"background .15s"}} onMouseEnter={e=>{if(!isDragOver)e.currentTarget.style.background="rgba(255,255,255,.04)";}} onMouseLeave={e=>{if(!isDragOver)e.currentTarget.style.background="transparent";}}>
                  <span style={{fontSize:7,transform:ic?"":"rotate(90deg)",display:"inline-block",transition:"transform .15s",color:"rgba(255,255,255,.35)"}}>▶</span>
                  <span style={{fontSize:11}}>{CAT_ICONS[cat]}</span><span style={{fontSize:11,fontWeight:700,color:isDragOver?"#579bfc":"rgba(255,255,255,.5)",letterSpacing:".5px",flex:1}}>{cat}</span>
                  {isDragOver&&<span style={{fontSize:10,color:"#579bfc",fontWeight:700}}>Drop here</span>}
                  {!isDragOver&&cb.length>0&&<span style={{fontSize:10,color:"rgba(255,255,255,.25)",background:"rgba(255,255,255,.08)",borderRadius:8,padding:"0 6px"}}>{cb.length}</span>}
                </div>
                {!ic&&<div>{cb.length===0&&<div style={{padding:"3px 38px",fontSize:11,color:"rgba(255,255,255,.2)",fontStyle:"italic"}}>Empty</div>}
                  {cb.map(b=>(<div key={b.id} draggable
                    onDragStart={e=>{setDragBoardId(b.id);e.dataTransfer.effectAllowed="move";}}
                    onDragEnd={()=>{setDragBoardId(null);setDragOverCat(null);setDragOverBoardId(null);}}
                    onDragOver={e=>{e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect="move";if(dragBoardId&&dragBoardId!==b.id)setDragOverBoardId(b.id);}}
                    onDragLeave={e=>{e.stopPropagation();if(dragOverBoardId===b.id)setDragOverBoardId(null);}}
                    onDrop={e=>{e.preventDefault();e.stopPropagation();setDragOverBoardId(null);setDragOverCat(null);if(!dragBoardId||dragBoardId===b.id)return;setBoards(bs=>{const n=[...bs];const fromIdx=n.findIndex(x=>x.id===dragBoardId);if(fromIdx<0)return bs;n[fromIdx]={...n[fromIdx],cat};const toIdx=n.findIndex(x=>x.id===b.id);const [moved]=n.splice(fromIdx,1);n.splice(toIdx,0,moved);return n;});setDragBoardId(null);}}
                    onClick={()=>setActiveId(b.id)} onContextMenu={e=>{e.preventDefault();setCtxMenu({x:e.clientX,y:e.clientY,type:"board",boardId:b.id});}} style={{padding:"5px 10px 5px 38px",fontSize:13,cursor:"grab",background:b.id===activeId?"rgba(255,255,255,.12)":"transparent",display:"flex",alignItems:"center",gap:7,color:b.id===activeId?"#fff":"rgba(255,255,255,.65)",borderRadius:4,margin:"1px 6px",borderLeft:b.id===activeId?"3px solid #579bfc":"3px solid transparent",borderTop:dragOverBoardId===b.id?"2px solid #579bfc":"2px solid transparent",transition:"all .1s",opacity:dragBoardId===b.id?0.4:1}} onMouseEnter={e=>{if(b.id!==activeId)e.currentTarget.style.background="rgba(255,255,255,.06)";}} onMouseLeave={e=>{e.currentTarget.style.background=b.id===activeId?"rgba(255,255,255,.12)":"transparent";}}>
                    <span style={{fontSize:11}}>{b.icon}{b.isMain?" 📊":b.isDashboard?" 📈":b.isSummary?" 📑":b.linkedMainBoardId?" 🔗":b.syncTargets?.length?" ⇄":""}</span>
                    {rnBoard===b.id?<input value={rnVal} onChange={e=>setRnVal(e.target.value)} onBlur={()=>{saveBN(b.id,rnVal);setRnBoard(null);}} onKeyDown={e=>{if(e.key==="Enter"){saveBN(b.id,rnVal);setRnBoard(null);}}} onClick={e=>e.stopPropagation()} style={{flex:1,background:"rgba(255,255,255,.15)",border:"none",color:"#fff",borderRadius:3,padding:"2px 6px",fontSize:12,outline:"none"}} autoFocus/>
                    :<span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name}</span>}
                  </div>))}
                </div>}
              </div>);
            })}
          </div>
          <div style={{padding:"8px 12px",borderTop:"1px solid rgba(255,255,255,.08)",display:"flex",gap:6}}>
            <button onClick={()=>setTemplateModal(true)} style={{flex:1,padding:"7px",background:"#6c5ce7",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>+ New board</button>
          </div>
        </div>}
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
        <div style={{background:"#fff",borderBottom:"1px solid #e6e9ef",padding:"0 24px"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"14px 0 2px"}}>
            <div style={{position:"relative"}}><div onClick={()=>setHeaderIconOpen(o=>!o)} style={{width:38,height:38,borderRadius:8,border:"2px solid "+(headerIconOpen?"#6c5ce7":"#e6e9ef"),display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,cursor:"pointer",background:headerIconOpen?"#f5f3ff":"#fafafa",transition:"all .15s",flexShrink:0}} title="Change icon">{board?.icon||"📋"}</div>
              {headerIconOpen&&<div style={{position:"absolute",top:"100%",left:0,marginTop:6,background:"#fff",border:"1px solid #e0e0e0",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,.15)",padding:10,display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:4,width:240,zIndex:100010}}>
                {BOARD_ICONS.map(ic=>(<div key={ic} onClick={()=>{saveIcon(activeId,ic);setHeaderIconOpen(false);}} style={{width:34,height:34,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,cursor:"pointer",background:board?.icon===ic?"#f0eeff":"transparent",border:board?.icon===ic?"2px solid #6c5ce7":"2px solid transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background=board?.icon===ic?"#f0eeff":"transparent"}>{ic}</div>))}
              </div>}
            </div>
            {editBN!=null?<input value={editBN} onChange={e=>setEditBN(e.target.value)} onBlur={()=>{saveBN(activeId,editBN);setEditBN(null);}} onKeyDown={e=>{if(e.key==="Enter"){saveBN(activeId,editBN);setEditBN(null);}}} style={{fontSize:22,fontWeight:700,border:"none",borderBottom:"2px solid #0073ea",outline:"none",background:"transparent"}} autoFocus/>
            :<h2 onClick={()=>setEditBN(board?.name||"")} style={{margin:0,fontSize:22,fontWeight:700,cursor:"pointer"}}>{board?.name||"Board"}</h2>}
            <div style={{flex:1}}/>
            <span onClick={()=>setActivityOpen(true)} style={{cursor:"pointer",fontSize:18}} title="Activity">📊</span>
            <div style={{position:"relative"}}><span onClick={()=>setNotifsOpen(true)} style={{cursor:"pointer",fontSize:18}}>🔔</span>{unreadCount>0&&<span style={{position:"absolute",top:-4,right:-6,background:"#e2445c",color:"#fff",borderRadius:"50%",width:16,height:16,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{unreadCount}</span>}</div>
            {searchOpen?<div style={{display:"flex",alignItems:"center",gap:6,background:"#f0f2f5",borderRadius:6,padding:"4px 10px"}}><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search..." style={{border:"none",background:"transparent",outline:"none",fontSize:13,width:150}} autoFocus/><span onClick={()=>{setSearchOpen(false);setSearch("");}} style={{cursor:"pointer",color:"#999"}}>✕</span></div>:<span onClick={()=>setSearchOpen(true)} style={{cursor:"pointer",fontSize:18}}>🔍</span>}
            <span onClick={undo} title={"Undo (Ctrl+Z)"+(undoRef.current.length?" · "+undoRef.current.length+" steps":"")} style={{cursor:undoRef.current.length?"pointer":"default",fontSize:18,opacity:undoRef.current.length?1:0.3,transition:"opacity .2s"}}>↩</span>
            <div style={{position:"relative"}}><span onClick={()=>setHistoryOpen(true)} style={{cursor:"pointer",fontSize:18}}>📜</span>{histBadge>0&&<span style={{position:"absolute",top:-4,right:-6,background:"#6c5ce7",color:"#fff",borderRadius:"50%",width:16,height:16,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{histBadge>99?"99+":histBadge}</span>}</div>
            <div ref={ioRef} style={{position:"relative"}}>
              <button onClick={()=>setIoMenuOpen(o=>!o)} style={{padding:"4px 10px",borderRadius:6,border:"1px solid "+(ioMenuOpen?"#6c5ce7":"#e0e0e0"),background:ioMenuOpen?"#f5f3ff":"#fff",cursor:"pointer",fontSize:12,color:ioMenuOpen?"#6c5ce7":"#555",fontWeight:600,display:"flex",alignItems:"center",gap:4}}>⇅ Import / Export</button>
              {ioMenuOpen&&<div style={{position:"absolute",top:"calc(100% + 6px)",right:0,background:"#fff",border:"1px solid #e0e0e0",borderRadius:10,boxShadow:"0 8px 30px rgba(0,0,0,.15)",width:260,zIndex:100012,overflow:"hidden"}}>
                <div style={{padding:"10px 14px 6px",fontSize:10,fontWeight:700,color:"#999",textTransform:"uppercase",letterSpacing:.8}}>Export</div>
                <div onClick={handleExportExcel} style={{padding:"8px 14px",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:8}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{fontSize:16}}>📗</span><div><div style={{fontWeight:600}}>Board → Excel</div><div style={{fontSize:10,color:"#999"}}>All groups & rows as .csv</div></div>
                </div>
                <div onClick={handleExportPDF} style={{padding:"8px 14px",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:8}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{fontSize:16}}>📄</span><div><div style={{fontWeight:600}}>Board → PDF</div><div style={{fontSize:10,color:"#999"}}>Screenshot of current view</div></div>
                </div>
                {board?.isDashboard&&<div onClick={handleExportDashExcel} style={{padding:"8px 14px",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:8}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{fontSize:16}}>📊</span><div><div style={{fontWeight:600}}>Dashboard → Excel</div><div style={{fontSize:10,color:"#999"}}>Stats, breakdown & all items</div></div>
                </div>}
                {board?.isSummary&&<div onClick={handleExportSummaryExcel} style={{padding:"8px 14px",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:8}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{fontSize:16}}>📑</span><div><div style={{fontWeight:600}}>Summary → Excel</div><div style={{fontSize:10,color:"#999"}}>Blockers, deadlines, active items</div></div>
                </div>}
                <div style={{borderTop:"1px solid #f0f0f0",margin:"4px 0"}}/>
                <div style={{padding:"10px 14px 6px",fontSize:10,fontWeight:700,color:"#999",textTransform:"uppercase",letterSpacing:.8}}>Import</div>
                <div onClick={handleImport} style={{padding:"8px 14px",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:8,marginBottom:6}} onMouseEnter={e=>e.currentTarget.style.background="#f5f6f8"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{fontSize:16}}>📥</span><div><div style={{fontWeight:600}}>Import from file</div><div style={{fontSize:10,color:"#999"}}>.csv file → new board</div></div>
                </div>
              </div>}
              <input ref={importRef} type="file" accept=".csv,.tsv,.txt" onChange={onImportFile} style={{display:"none"}}/>
            </div>
            <div style={{width:1,height:24,background:"#e6e9ef",margin:"0 2px"}}/>
            <div ref={userMenuRef} style={{position:"relative"}}>
              <div onClick={()=>setUserMenuOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",padding:"3px 8px 3px 4px",borderRadius:20,background:userMenuOpen?"#f0eeff":"transparent",transition:"background .12s"}} onMouseEnter={e=>{if(!userMenuOpen)e.currentTarget.style.background="#f5f6f8";}} onMouseLeave={e=>{if(!userMenuOpen)e.currentTarget.style.background="transparent";}}>
                <div style={{width:30,height:30,borderRadius:"50%",background:currentUser.color,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,position:"relative",flexShrink:0}}>
                  {Initials(currentUser.name)}
                  <div style={{position:"absolute",bottom:0,right:0,width:9,height:9,borderRadius:"50%",background:"#00c875",border:"2px solid #fff"}}/>
                </div>
                <span style={{fontSize:12,fontWeight:600,color:"#333",maxWidth:80,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentUser.name}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 4l3 3 3-3" stroke="#999" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              {userMenuOpen&&<UserMenu currentUser={currentUser} setCurrentUser={setCurrentUser} teamMembers={teamMembers} onOpenAdmin={()=>{setUserMenuOpen(false);setAdminOpen(true);}} onClose={()=>setUserMenuOpen(false)} onLogout={onLogout}/>}
            </div>
          </div>
          {editDesc?<div style={{paddingBottom:6}}><input value={descVal} onChange={e=>setDescVal(e.target.value)} onBlur={()=>{saveDesc(activeId,descVal);setEditDesc(false);}} onKeyDown={e=>{if(e.key==="Enter"){saveDesc(activeId,descVal);setEditDesc(false);}}} style={{width:"100%",border:"none",borderBottom:"1px solid #ddd",fontSize:13,color:"#666",outline:"none",padding:"2px 0",boxSizing:"border-box"}} autoFocus/></div>
          :<div onClick={()=>{setEditDesc(true);setDescVal(board?.desc||"");}} style={{fontSize:13,color:board?.desc?"#666":"#bbb",paddingBottom:6,cursor:"pointer"}}>{board?.desc||"Add a board description..."}</div>}
          {board?.isDashboard?<div style={{paddingBottom:10,fontSize:13,color:"#888",display:"flex",alignItems:"center",gap:10}}>Cross-board analytics — aggregates all task boards in your workspace <button onClick={handleExportDashExcel} style={{padding:"3px 10px",borderRadius:5,border:"1px solid #e0e0e0",background:"#fff",cursor:"pointer",fontSize:11,color:"#555",display:"flex",alignItems:"center",gap:4}}>📗 Excel</button><button onClick={handleExportPDF} style={{padding:"3px 10px",borderRadius:5,border:"1px solid #e0e0e0",background:"#fff",cursor:"pointer",fontSize:11,color:"#555",display:"flex",alignItems:"center",gap:4}}>📄 PDF</button></div>
          :board?.isSummary?<div style={{paddingBottom:10,fontSize:13,color:"#888",display:"flex",alignItems:"center",gap:10}}>Executive summary — categorized action items for leadership review <button onClick={handleExportSummaryExcel} style={{padding:"3px 10px",borderRadius:5,border:"1px solid #e0e0e0",background:"#fff",cursor:"pointer",fontSize:11,color:"#555",display:"flex",alignItems:"center",gap:4}}>📗 Excel</button><button onClick={handleExportPDF} style={{padding:"3px 10px",borderRadius:5,border:"1px solid #e0e0e0",background:"#fff",cursor:"pointer",fontSize:11,color:"#555",display:"flex",alignItems:"center",gap:4}}>📄 PDF</button></div>
          :<div style={{display:"flex",alignItems:"center",gap:6,paddingBottom:10,flexWrap:"wrap"}}>
            {["Main table","Kanban","Dashboard","Gantt"].map(v=>(<button key={v} onClick={()=>setActiveView(v)} style={{padding:"5px 12px",borderRadius:6,border:activeView===v?"none":"1px solid #e0e0e0",background:activeView===v?"#fff":"transparent",cursor:"pointer",fontSize:13,fontWeight:activeView===v?600:400,boxShadow:activeView===v?"0 1px 3px rgba(0,0,0,.08)":"none"}}>{v}</button>))}
            <button disabled={boardReadonly} onClick={()=>addRow(board?.groups?.[0]?.id)} style={{padding:"5px 14px",borderRadius:6,border:"none",background:boardReadonly?"#ccc":"#0073ea",color:"#fff",cursor:boardReadonly?"default":"pointer",fontSize:13,fontWeight:600}}>+ Item</button>
            <button disabled={boardReadonly} onClick={addGroup} style={{padding:"5px 12px",borderRadius:6,border:"1px solid #e0e0e0",background:boardReadonly?"#f5f5f5":"#fff",cursor:boardReadonly?"default":"pointer",fontSize:13,color:boardReadonly?"#ccc":"#333"}}>+ Group</button>
            <div style={{position:"relative"}}><button onClick={()=>setFilterOpen(!filterOpen)} style={{padding:"5px 12px",borderRadius:6,border:"1px solid #e0e0e0",background:filterOpen?"#e6f0ff":"#fff",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:4}}>🔽 Filter {Object.values(filters).flat().length>0&&<span style={{background:"#6c5ce7",color:"#fff",borderRadius:8,padding:"0 6px",fontSize:10}}>{Object.values(filters).flat().length}</span>}{globalSortBy!=="Default"&&<span style={{background:"#fdab3d",color:"#fff",borderRadius:8,padding:"0 6px",fontSize:10}}>Sort</span>}{hiddenCols.length>0&&<span style={{background:"#a25ddc",color:"#fff",borderRadius:8,padding:"0 6px",fontSize:10}}>-{hiddenCols.length}</span>}</button>{filterOpen&&<FilterPanel filters={filters} setFilters={setFilters} people={people} statuses={statuses} priorities={priorities} allTags={allTags} onClose={()=>setFilterOpen(false)} sortBy={globalSortBy} setSortBy={setGlobalSortBy} hiddenCols={hiddenCols} setHiddenCols={setHiddenCols}/>}</div>
            <button onClick={()=>setAutoPanel(true)} style={{padding:"5px 12px",borderRadius:6,border:"1px solid #e0e0e0",background:"#fff",cursor:"pointer",fontSize:13}}>⚡ Auto {boardAutos.filter(a=>a.enabled).length>0&&<span style={{background:"#fdab3d",color:"#fff",borderRadius:8,padding:"0 6px",fontSize:10,marginLeft:2}}>{boardAutos.filter(a=>a.enabled).length}</span>}</button>
            {!board?.isMain&&<button onClick={()=>setSyncModal(true)} style={{padding:"5px 12px",borderRadius:6,border:"1px solid "+(board?.syncTargets?.length?"#a25ddc":"#e0e0e0"),background:board?.syncTargets?.length?"#f5f3ff":"#fff",cursor:"pointer",fontSize:13,color:board?.syncTargets?.length?"#a25ddc":"#333"}}>🔗 Sync {board?.syncTargets?.length>0&&<span style={{background:"#a25ddc",color:"#fff",borderRadius:8,padding:"0 6px",fontSize:10,marginLeft:2}}>{board.syncTargets.length}</span>}</button>}
            <button onClick={()=>setSharePanel(true)} style={{padding:"5px 12px",borderRadius:6,border:"1px solid "+(board?.shared?.length?"#0073ea":"#e0e0e0"),background:board?.shared?.length?"#e6f0ff":"#fff",cursor:"pointer",fontSize:13,color:board?.shared?.length?"#0073ea":"#333"}}>👥 Share {board?.shared?.length>0&&<span style={{background:"#0073ea",color:"#fff",borderRadius:8,padding:"0 6px",fontSize:10,marginLeft:2}}>{board.shared.length}</span>}</button>
          </div>}
        </div>

        <div ref={contentRef} style={{flex:1,overflow:"auto",padding:"16px 24px 24px"}}>
          {board?.isDashboard&&<DashboardBoard boards={boards} statuses={statuses} priorities={priorities}/>}
          {board?.isSummary&&<SummaryBoard boards={boards} boardId={board.summarySrc} onChangeSrc={changeSummarySrc}/>}
          {!board?.isDashboard&&!board?.isSummary&&board?.isMain&&<SyncBanner icon="📊" title="Portfolio Board" sub="– Status & Progress auto-sync from linked task boards" pill="Live Sync ON"/>}
          {boardReadonly&&<div style={{background:"#fff8e7",border:"1px solid #ffeaa0",borderRadius:8,padding:"10px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10,fontSize:13}}><span style={{fontSize:16}}>🔒</span><span style={{fontWeight:600,color:"#b8860b"}}>View Only</span><span style={{color:"#999"}}>— You have read-only access to this board. Contact the owner to request edit access.</span></div>}
          {board&&!board.isMain&&board.linkedMainBoardId&&<SyncBanner icon="🔗" title="Linked Board" sub="– Changes sync to portfolio board automatically" pill="Live Sync ON"/>}
          {board&&!board.isMain&&board.syncTargets?.length>0&&<div style={{background:"linear-gradient(90deg,#faf5ff,#f5f0ff)",border:"1px solid #e0d8ff",borderRadius:8,padding:"10px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10,fontSize:13,flexWrap:"wrap"}}>
            <span style={{fontWeight:600}}>⇄ Cross-board sync</span><span style={{color:"#888"}}>→ {board.syncTargets.length} board{board.syncTargets.length>1?"s":""}: </span>
            {board.syncTargets.map(st2=>{const tb=boards.find(b2=>b2.id===st2.boardId);return tb?<span key={st2.boardId} style={{background:"#f0eeff",color:"#6c5ce7",padding:"2px 8px",borderRadius:10,fontSize:11,fontWeight:600}}>{tb.name}</span>:null;})}
            <span style={{marginLeft:"auto",background:"linear-gradient(135deg,#a25ddc,#6c5ce7)",color:"#fff",borderRadius:20,padding:"2px 12px",fontSize:11,fontWeight:700}}>Cross Sync</span>
          </div>}
          {activeView==="Main table"&&!board?.isDashboard&&!board?.isSummary&&board?.isMain&&board.groups.map(group=>{
            const rows=processRows(group.rows,group.id);const isH=hovGroup===group.id;const ss=sortSt[group.id];
            const mCols=board.columns||MAIN_COLS;const visCols=hiddenCols.length>0?mCols.filter(c=>!hiddenCols.includes(c.name)):mCols;
            return(<div key={group.id} style={{marginBottom:18}} draggable onDragStart={()=>setDragGroup(group.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>onGDrop(e,group.id)}>
              <div onMouseEnter={()=>setHovGroup(group.id)} onMouseLeave={()=>setHovGroup(null)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",background:group.color,borderRadius:"8px 8px 0 0",cursor:"grab"}}>
                <span onClick={e=>{e.stopPropagation();togGroup(group.id);}} style={{cursor:"pointer",fontSize:11,color:"#fff",transform:group.collapsed?"rotate(-90deg)":"",transition:"transform .15s"}}>▼</span>
                <span style={{fontSize:14,fontWeight:700,color:"#fff"}}>{group.name}</span>
                <span style={{fontSize:11,color:"rgba(255,255,255,.7)"}}>{group.rows.length} projects</span>
                <div style={{flex:1}}/><span onClick={e=>{e.stopPropagation();delGroup(group.id);}} style={{cursor:"pointer",color:"rgba(255,255,255,.5)",fontSize:13,opacity:isH?1:0,transition:"opacity .15s"}}>✕</span>
              </div>
              {!group.collapsed&&<div style={{background:"#fff",borderRadius:"0 0 8px 8px",border:"1px solid #e6e9ef",borderTop:"none"}}><div style={{overflowX:"auto"}}>
                <div style={{display:"flex",borderBottom:"1px solid #e6e9ef",background:"#fafbfc",minWidth:"fit-content"}}>
                  <div style={{width:44,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><input type="checkbox" checked={group.rows.length>0&&group.rows.every(r=>r.checked)} onChange={e=>selectAllInGroup(group.id,e.target.checked)} style={{margin:0}}/></div>
                  {visCols.map(col=>{const sortId=col.id==="tltype"?"timeline":col.id==="progress"?"projectProgress":col.id;const isSorted=ss&&ss.colId===sortId;const isColDrag=dragCol===col.id;const isColOver=dragOverCol===col.id&&dragCol&&dragCol!==col.id;return(<div key={col.id} draggable={!resizing} onDragStart={e=>{e.stopPropagation();setDragCol(col.id);e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("colDrag",col.id);}} onDragOver={e=>{e.preventDefault();e.stopPropagation();if(dragCol&&dragCol!==col.id)setDragOverCol(col.id);}} onDragLeave={()=>{if(dragOverCol===col.id)setDragOverCol(null);}} onDrop={e=>{e.preventDefault();e.stopPropagation();if(dragCol&&dragCol!==col.id)reorderCol(dragCol,col.id);setDragCol(null);setDragOverCol(null);}} onDragEnd={()=>{setDragCol(null);setDragOverCol(null);}} style={{width:col.w,flexShrink:0,padding:"7px 6px",fontSize:12,fontWeight:600,color:"#555",display:"flex",alignItems:"center",gap:2,borderRight:"1px solid #f0f0f0",cursor:"grab",background:isColOver?"#dbeafe":isSorted?"#eef3ff":"transparent",borderLeft:isColOver?"2px solid #0073ea":"2px solid transparent",opacity:isColDrag?0.4:1,transition:"background .12s, opacity .12s",position:"relative"}} onMouseEnter={e=>e.currentTarget.querySelector('.colMenu')&&(e.currentTarget.querySelector('.colMenu').style.opacity=1)} onMouseLeave={e=>e.currentTarget.querySelector('.colMenu')&&(e.currentTarget.querySelector('.colMenu').style.opacity=0)}>
                    <span onClick={()=>{if(col.id==="linkedBoard")return;const nd=isSorted&&ss.dir==="asc"?"desc":isSorted&&ss.dir==="desc"?null:"asc";doSort(group.id,sortId,nd);}} style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{col.name}{col.synced&&<span style={{marginLeft:4,fontSize:9,color:"#a25ddc"}}>🔗</span>}</span>
                    {isSorted&&<span style={{fontSize:9,color:"#0073ea"}}>{ss.dir==="asc"?"↑":"↓"}</span>}
                    <span className="colMenu" onClick={e=>{e.stopPropagation();setColCtx({x:e.clientX,y:e.clientY,colId:col.id,gId:group.id});}} style={{opacity:0,cursor:"pointer",padding:"2px 3px",borderRadius:3,color:"#999",fontSize:14,transition:"opacity .15s",lineHeight:1}} onMouseEnter={e=>e.currentTarget.style.background="#eee"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>⋮</span>
                    <div onMouseDown={e=>onResizeStart(e,col.id)} onDoubleClick={()=>onResizeDblClick(col.id)} onClick={e=>e.stopPropagation()} style={{position:"absolute",right:-6,top:0,bottom:0,width:16,cursor:"col-resize",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2}} onMouseEnter={e=>e.currentTarget.firstChild.style.background="#0073ea"} onMouseLeave={e=>{if(resizing!==col.id)e.currentTarget.firstChild.style.background="#d8dbe0";}}><div style={{width:3,height:"60%",borderRadius:2,background:resizing===col.id?"#0073ea":"#d8dbe0",transition:"background .12s"}}/></div>
                  </div>);})}
                  <div style={{width:36,flexShrink:0}}/>
                </div>
                {rows.map(row=>{
                  const linked=boards.find(b=>b.linkedMainItemName===row.task&&!b.isMain);
                  const prog=row.projectProgress||0;
                  return(<div key={row.id} style={{display:"flex",borderBottom:"1px solid #f0f0f0",minWidth:"fit-content"}} draggable onDragStart={()=>setDragRow({gId:group.id,rId:row.id})} onDragOver={e=>{e.preventDefault();if(!dragCol)e.currentTarget.style.borderTop="2px solid #0073ea";}} onDragLeave={e=>{e.currentTarget.style.borderTop="";}} onDrop={e=>onRowDrop(e,group.id,row.id)} onMouseEnter={e=>e.currentTarget.style.background="#f8faff"} onMouseLeave={e=>e.currentTarget.style.background="transparent"} onContextMenu={e=>{e.preventDefault();setCtxMenu({x:e.clientX,y:e.clientY,type:"row",gId:group.id,rId:row.id,groups:board.groups});}}>
                    <div style={{width:44,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><input type="checkbox" checked={row.checked||false} onChange={e=>upRow(group.id,row.id,"checked",e.target.checked)} style={{margin:0}}/></div>
                    {visCols.map(col=>{
                      if(col.id==="task")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",display:"flex",alignItems:"center",gap:6,fontWeight:600,fontSize:13,borderRight:"1px solid #f5f5f5"}}>
                        <span onClick={()=>setDetailPanel({gId:group.id,rId:row.id})} style={{cursor:"pointer"}}>{row.task||"—"}</span>
                        {linked&&<span style={{background:"#f0eeff",color:"#6c5ce7",borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:700}}>linked</span>}
                      </div>);
                      if(col.id==="owner")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}><select value={row.owner} onChange={e=>upRow(group.id,row.id,"owner",e.target.value)} style={{border:"none",background:"transparent",fontSize:12,outline:"none",width:"100%"}}><option value="">—</option>{people.map(p=><option key={p}>{p}</option>)}</select></div>);
                      if(col.id==="status")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}>{linked?<div title="Auto-synced from linked board" style={{background:SC[row.status]||"#ccc",color:"#fff",borderRadius:4,padding:"3px 10px",fontSize:11,fontWeight:700,textAlign:"center"}}>{row.status} 🔗</div>:<select value={row.status} onChange={e=>upRow(group.id,row.id,"status",e.target.value)} style={{width:"100%",padding:"4px",borderRadius:4,border:"none",background:SC[row.status]||"#ccc",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",outline:"none"}}>{statuses.map(s=><option key={s}>{s}</option>)}</select>}</div>);
                      if(col.id==="priority")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}><select value={row.priority} onChange={e=>upRow(group.id,row.id,"priority",e.target.value)} style={{width:"100%",padding:"4px",borderRadius:4,border:"none",background:PC[row.priority]||"#ccc",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",outline:"none"}}>{priorities.map(p=><option key={p}>{p}</option>)}</select></div>);
                      if(col.id==="tltype")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}><select value={row.timeline||""} onChange={e=>upRow(group.id,row.id,"timeline",e.target.value)} style={{padding:"3px 8px",borderRadius:4,border:"none",background:TL_TYPE_C[row.timeline]||"#ccc",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",outline:"none",width:"100%"}}>{TL_TYPES.map(t=><option key={t}>{t}</option>)}</select></div>);
                      if(col.id==="customer")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}><select value={row.customer||""} onChange={e=>upRow(group.id,row.id,"customer",e.target.value)} style={{padding:"3px 8px",borderRadius:4,border:"none",background:CUST_C[row.customer]||"#ccc",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",outline:"none",width:"100%"}}>{CUSTOMERS.map(c=><option key={c}>{c}</option>)}</select></div>);
                      if(col.id==="team")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}><select value={row.team||""} onChange={e=>upRow(group.id,row.id,"team",e.target.value)} style={{padding:"3px 8px",borderRadius:4,border:"none",background:row.team?"#f0eeff":"#f5f6f8",color:row.team?"#6c5ce7":"#aaa",fontSize:11,fontWeight:700,cursor:"pointer",outline:"none",width:"100%"}}><option value="">—</option>{TEAMS.map(t=><option key={t}>{t}</option>)}</select></div>);
                      if(col.id==="progress")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}><div style={{display:"flex",alignItems:"center",gap:6}}><div style={{flex:1,height:8,borderRadius:4,background:"#e0e0e0"}}><div style={{width:prog+"%",background:"linear-gradient(90deg,#6c5ce7,#0984e3)",height:8,borderRadius:4,transition:"width 0.4s"}}/></div><span style={{fontSize:11,color:"#888",minWidth:28}}>{prog}%</span></div></div>);
                      if(col.id==="weeklyUpdate")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",fontSize:12,color:linked?"#888":"#333",borderRight:"1px solid #f5f5f5"}}>{linked?<span title="Auto-synced">{row.weeklyUpdate||"—"} 🔗</span>:<input value={row.weeklyUpdate||""} onChange={e=>upRow(group.id,row.id,"weeklyUpdate",e.target.value)} style={{width:"100%",border:"none",background:"transparent",fontSize:12,outline:"none"}} placeholder="Update..."/>}</div>);
                      if(col.id==="linkedBoard")return(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}>{linked?<button onClick={()=>setActiveId(linked.id)} style={{background:"#f0eeff",color:"#6c5ce7",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11,fontWeight:700}}>{linked.name} →</button>:<span style={{color:"#ccc",fontSize:11}}>No link</span>}</div>);
                      return <div key={col.id} style={{width:col.w,flexShrink:0,padding:"6px 8px",borderRight:"1px solid #f5f5f5"}}>—</div>;
                    })}
                    <div style={{width:36,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><span onClick={()=>setConfirmDel({type:"row",gId:group.id,rId:row.id,name:row.task||"this project"})} title="Delete" style={{cursor:"pointer",color:"#ccc",fontSize:14,fontWeight:600,lineHeight:1}} onMouseEnter={e=>{e.currentTarget.style.color="#e2445c";}} onMouseLeave={e=>{e.currentTarget.style.color="#ccc";}}>✕</span></div>
                  </div>);
                })}
                <div onClick={()=>addRow(group.id)} onDragOver={e=>{e.preventDefault();e.currentTarget.style.background="#e6f0ff";}} onDragLeave={e=>{e.currentTarget.style.background="";}} onDrop={e=>{e.currentTarget.style.background="";onRowDrop(e,group.id,"__end__");}} style={{padding:"7px 16px 7px 44px",color:"#0073ea",cursor:"pointer",fontSize:13}} onMouseEnter={e=>e.currentTarget.style.background="#f8faff"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>+ New project</div>
              </div></div>}
            </div>);
          })}
          {activeView==="Main table"&&!board?.isDashboard&&!board?.isSummary&&board&&!board.isMain&&board?.groups.map(group=>{
            const rows=processRows(group.rows,group.id);const gC=getGCols(group);const isH=hovGroup===group.id;const ss=sortSt[group.id];
            return(<div key={group.id} style={{marginBottom:18}} draggable onDragStart={()=>setDragGroup(group.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>onGDrop(e,group.id)}>
              <div onMouseEnter={()=>setHovGroup(group.id)} onMouseLeave={()=>setHovGroup(null)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",background:group.color,borderRadius:"8px 8px 0 0",cursor:"grab"}}>
                <span onClick={e=>{e.stopPropagation();togGroup(group.id);}} style={{cursor:"pointer",fontSize:11,color:"#fff",transform:group.collapsed?"rotate(-90deg)":"",transition:"transform .15s"}}>▼</span>
                <input value={group.name} onChange={e=>rnGroup(group.id,e.target.value)} onClick={e=>e.stopPropagation()} style={{border:"none",fontSize:14,fontWeight:700,color:"#fff",background:"transparent",outline:"none",width:180}}/>
                <ProgBar rows={group.rows}/>
                <span style={{fontSize:11,color:"rgba(255,255,255,.7)",opacity:isH?1:0,transition:"opacity .15s"}}>{group.rows.length} items</span>
                <div style={{flex:1}}/><span onClick={e=>{e.stopPropagation();delGroup(group.id);}} style={{cursor:"pointer",color:"rgba(255,255,255,.5)",fontSize:13,opacity:isH?1:0,transition:"opacity .15s"}}>✕</span>
              </div>
              {!group.collapsed&&<div style={{background:"#fff",borderRadius:"0 0 8px 8px",border:"1px solid #e6e9ef",borderTop:"none"}}><div style={{overflowX:"auto"}}>
                <div style={{display:"flex",borderBottom:"1px solid #e6e9ef",background:"#fafbfc",minWidth:"fit-content"}}>
                  <div style={{width:44,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><input type="checkbox" checked={group.rows.filter(r=>!r._syncReadonly).length>0&&group.rows.filter(r=>!r._syncReadonly).every(r=>r.checked)} onChange={e=>selectAllInGroup(group.id,e.target.checked)} style={{margin:0}}/></div>
                  {gC.map(col=>{const isSorted=ss&&ss.colId===(col.id==="timeline"?"tlStart":col.id);const isRn=rnColId===col.id;const isColDrag=dragCol===col.id;const isColOver=dragOverCol===col.id&&dragCol&&dragCol!==col.id;return(<div key={col.id} draggable={!isRn&&!resizing} onDragStart={e=>{e.stopPropagation();setDragCol(col.id);e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("colDrag",col.id);}} onDragOver={e=>{e.preventDefault();e.stopPropagation();if(dragCol&&dragCol!==col.id)setDragOverCol(col.id);}} onDragLeave={()=>{if(dragOverCol===col.id)setDragOverCol(null);}} onDrop={e=>{e.preventDefault();e.stopPropagation();if(dragCol&&dragCol!==col.id)reorderCol(dragCol,col.id);setDragCol(null);setDragOverCol(null);}} onDragEnd={()=>{setDragCol(null);setDragOverCol(null);}} style={{width:col.w,flexShrink:0,padding:"7px 6px",fontSize:12,fontWeight:600,color:"#555",display:"flex",alignItems:"center",gap:2,borderRight:"1px solid #f0f0f0",cursor:isRn?"text":"grab",background:isColOver?"#dbeafe":isSorted?"#eef3ff":"transparent",borderLeft:isColOver?"2px solid #0073ea":"2px solid transparent",opacity:isColDrag?0.4:1,transition:"background .12s, opacity .12s",position:"relative"}} onMouseEnter={e=>e.currentTarget.querySelector('.colMenu')&&(e.currentTarget.querySelector('.colMenu').style.opacity=1)} onMouseLeave={e=>e.currentTarget.querySelector('.colMenu')&&(e.currentTarget.querySelector('.colMenu').style.opacity=0)}>
                    {isRn?<input value={rnColVal} onChange={e=>setRnColVal(e.target.value)} onBlur={()=>{rnCol(col.id,rnColVal);setRnColId(null);}} onKeyDown={e=>{if(e.key==="Enter"){rnCol(col.id,rnColVal);setRnColId(null);}}} onClick={e=>e.stopPropagation()} style={{flex:1,border:"none",borderBottom:"2px solid #0073ea",background:"transparent",fontSize:12,fontWeight:600,outline:"none",padding:"0 2px"}} autoFocus/>
                    :<span onClick={()=>{if(col.id==="weeklyStatus")return;const cid=col.id==="timeline"?"tlStart":col.id;const nd=isSorted&&ss.dir==="asc"?"desc":isSorted&&ss.dir==="desc"?null:"asc";doSort(group.id,cid,nd);}} style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{col.name}</span>}
                    {isSorted&&<span style={{fontSize:9,color:"#0073ea"}}>{ss.dir==="asc"?"↑":"↓"}</span>}
                    <span className="colMenu" onClick={e=>{e.stopPropagation();setColCtx({x:e.clientX,y:e.clientY,colId:col.id,gId:group.id});}} style={{opacity:0,cursor:"pointer",padding:"2px 3px",borderRadius:3,color:"#999",fontSize:14,transition:"opacity .15s",lineHeight:1}} onMouseEnter={e=>e.currentTarget.style.background="#eee"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>⋮</span>
                    <div onMouseDown={e=>onResizeStart(e,col.id)} onDoubleClick={()=>onResizeDblClick(col.id)} onClick={e=>e.stopPropagation()} style={{position:"absolute",right:-6,top:0,bottom:0,width:16,cursor:"col-resize",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2}} onMouseEnter={e=>e.currentTarget.firstChild.style.background="#0073ea"} onMouseLeave={e=>{if(resizing!==col.id)e.currentTarget.firstChild.style.background="#d8dbe0";}}><div style={{width:3,height:"60%",borderRadius:2,background:resizing===col.id?"#0073ea":"#d8dbe0",transition:"background .12s"}}/></div>
                  </div>);})}
                  <div onClick={e=>{e.stopPropagation();setColCtx({x:e.clientX,y:e.clientY,colId:null,gId:group.id,addOnly:true});}} style={{width:36,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#aaa",fontSize:18}} title="Add column">+</div>
                </div>
                {rows.map(row=>{const hasSub=(row.subitems||[]).length>0;const isExp=expandedSub[row.id];const od=isOverdue(row);const isSynced=!!row._syncReadonly;return(<div key={row.id}>
                  <div draggable={!isSynced} onDragStart={()=>{if(!isSynced)setDragRow({gId:group.id,rId:row.id});}} onDragOver={e=>{e.preventDefault();if(!dragCol)e.currentTarget.style.borderTop="2px solid #0073ea";}} onDragLeave={e=>{e.currentTarget.style.borderTop="";}} onDrop={e=>onRowDrop(e,group.id,row.id)}
                    onContextMenu={e=>{e.preventDefault();if(!isSynced)setCtxMenu({x:e.clientX,y:e.clientY,type:"row",gId:group.id,rId:row.id,groups:board.groups});}}
                    style={{display:"flex",borderBottom:"1px solid #f0f0f0",minWidth:"fit-content",cursor:isSynced?"default":"grab",borderLeft:isSynced?"3px solid #a25ddc":od?"3px solid #e2445c":"3px solid transparent",background:isSynced?"#faf8ff":"transparent",transition:"all .1s"}} onMouseEnter={e=>{if(!isSynced)e.currentTarget.style.background="#f8faff";}} onMouseLeave={e=>{e.currentTarget.style.background=isSynced?"#faf8ff":"transparent";}}>
                    <div style={{width:44,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",gap:1}}>
                      {isSynced?<span style={{fontSize:10,color:"#a25ddc"}} title="Synced from another board">⇄</span>
                      :<>{hasSub&&<span onClick={()=>setExpandedSub(s=>({...s,[row.id]:!s[row.id]}))} style={{cursor:"pointer",fontSize:8,color:"#999",transform:isExp?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block"}}>▶</span>}
                      <input type="checkbox" checked={row.checked||false} onChange={e=>upRow(group.id,row.id,"checked",e.target.checked)} style={{margin:0}}/></>}
                    </div>
                    {gC.map(col=>(<div key={col.id} style={{width:col.w,flexShrink:0,padding:"2px 4px",display:"flex",alignItems:"center",borderRight:"1px solid #f5f5f5"}}>
                      {col.id==="weeklyStatus"?<input value={row.weeklyStatus||""} onChange={e=>upRow(group.id,row.id,"weeklyStatus",e.target.value)} placeholder="Status..." style={{width:"100%",border:"none",background:"transparent",padding:"6px 8px",fontSize:13,outline:"none"}}/>
                      :<Cell col={col} row={row} onChange={(f,v)=>upRow(group.id,row.id,f,v)} onOpenUpdates={()=>setUpdPanel({gId:group.id,rId:row.id})} onOpenDetail={col.id==="task"?()=>setDetailPanel({gId:group.id,rId:row.id}):null} people={people} setPeople={setPeople} statuses={statuses} setStatuses={setStatuses} priorities={priorities} setPriorities={setPriorities} allTags={allTags} setAllTags={setAllTags} readonly={!!row._syncReadonly} onEditLabels={(cid,labels)=>setCols(cs=>cs.map(c=>c.id!==cid?c:{...c,labels}))}/>}
                    </div>))}
                    <div style={{width:40,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                      {isSynced?<span style={{fontSize:9,color:"#a25ddc"}} title="Mirror row – read only">🔒</span>
                      :<><span onClick={()=>addSubitem(group.id,row.id)} title="Add subitem" style={{cursor:"pointer",color:"#bbb",fontSize:13}}>⊕</span>
                      <span onClick={()=>setConfirmDel({type:"row",gId:group.id,rId:row.id,name:row.task||"this task"})} title="Delete" style={{cursor:"pointer",color:"#ccc",fontSize:14,fontWeight:600,lineHeight:1}} onMouseEnter={e=>{e.currentTarget.style.color="#e2445c";}} onMouseLeave={e=>{e.currentTarget.style.color="#ccc";}}>✕</span></>}
                    </div>
                  </div>
                  {isExp&&(row.subitems||[]).map(si=>(<div key={si.id} style={{display:"flex",borderBottom:"1px solid #f8f8f8",minWidth:"fit-content",background:"#fafbfe",paddingLeft:20}}>
                    <div style={{width:24,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:8,color:"#ccc"}}>↳</span></div>
                    <div style={{width:200,flexShrink:0,padding:"3px 6px"}}><input value={si.task} onChange={e=>upSubitem(group.id,row.id,si.id,"task",e.target.value)} placeholder="Subitem..." style={{width:"100%",border:"none",background:"transparent",padding:"4px",fontSize:12,outline:"none"}}/></div>
                    <div style={{width:80,flexShrink:0,padding:"3px 4px"}}><select value={si.owner} onChange={e=>upSubitem(group.id,row.id,si.id,"owner",e.target.value)} style={{border:"none",background:"transparent",fontSize:11,outline:"none",width:"100%"}}><option value="">—</option>{people.map(p=>(<option key={p}>{p}</option>))}</select></div>
                    <div style={{width:55,flexShrink:0}}/>
                    <div style={{width:120,flexShrink:0,padding:"3px 4px"}}><select value={si.status} onChange={e=>upSubitem(group.id,row.id,si.id,"status",e.target.value)} style={{width:"100%",padding:"3px",borderRadius:3,border:"none",background:SC[si.status]||"#ccc",color:"#fff",fontSize:11,fontWeight:600,outline:"none",cursor:"pointer"}}>{statuses.map(s=>(<option key={s}>{s}</option>))}</select></div>
                    <div style={{flex:1}}/><div style={{width:36,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><span onClick={()=>delSubitem(group.id,row.id,si.id)} style={{cursor:"pointer",color:"#ddd",fontSize:10}}>✕</span></div>
                  </div>))}
                  {isExp&&<div onClick={()=>addSubitem(group.id,row.id)} style={{padding:"4px 16px 4px 50px",color:"#0073ea",cursor:"pointer",fontSize:12,background:"#fafbfe"}}>+ subitem</div>}
                </div>);})}
                <div onClick={()=>addRow(group.id)} onDragOver={e=>{e.preventDefault();e.currentTarget.style.background="#e6f0ff";}} onDragLeave={e=>{e.currentTarget.style.background="";}} onDrop={e=>{e.currentTarget.style.background="";onRowDrop(e,group.id,"__end__");}} style={{padding:"7px 16px 7px 44px",color:"#0073ea",cursor:"pointer",fontSize:13}} onMouseEnter={e=>e.currentTarget.style.background="#f8faff"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>+ Add task</div>
              </div></div>}
            </div>);
          })}
          {!board?.isDashboard&&!board?.isSummary&&activeView==="Kanban"&&<KanbanView statuses={statuses} allRows={filteredAllRows}/>}
          {!board?.isDashboard&&!board?.isSummary&&activeView==="Dashboard"&&<DashView allRows={filteredAllRows}/>}
          {!board?.isDashboard&&!board?.isSummary&&activeView==="Gantt"&&<GanttView allRows={filteredAllRows}/>}
        </div>
      </div>

      {autoPanel&&<AutoPanel autos={boardAutos} setAutos={a=>setAutos({...autos,[activeId]:a})} onClose={()=>setAutoPanel(false)} boardName={board?.name}/>}
      {historyOpen&&<SidePanel title="📜 History" sub="All boards" onClose={()=>setHistoryOpen(false)} width={460}><div style={{display:"flex",gap:4,padding:"8px 16px",borderBottom:"1px solid #eee",overflowX:"auto",flexShrink:0}}>
        <button onClick={()=>setHistFilter("all")} style={{padding:"4px 10px",borderRadius:16,border:"none",background:histFilter==="all"?"#292f4c":"#f0f0f0",color:histFilter==="all"?"#fff":"#666",fontSize:11,cursor:"pointer",fontWeight:histFilter==="all"?700:400,whiteSpace:"nowrap",flexShrink:0}}>All</button>
        {wsBoards.map(b=>(<button key={b.id} onClick={()=>setHistFilter(b.id)} style={{padding:"4px 10px",borderRadius:16,border:"none",background:histFilter===b.id?"#292f4c":"#f0f0f0",color:histFilter===b.id?"#fff":"#666",fontSize:11,cursor:"pointer",fontWeight:histFilter===b.id?700:400,whiteSpace:"nowrap",flexShrink:0}}>{b.name}</button>))}
      </div><div style={{flex:1,overflowY:"auto",padding:16}}>
        {histItems.length===0?<div style={{color:"#aaa",textAlign:"center",padding:30}}>No changes yet</div>
        :histItems.slice().reverse().map((e,i)=>(<div key={i} style={{marginBottom:8,padding:"10px 14px",background:"#f7f8fa",borderRadius:8,borderLeft:`3px solid ${e.color||"#579bfc"}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:12,fontWeight:600}}>{e.action}</span><span style={{fontSize:10,color:"#999"}}>{e.time}</span></div>
          {e.detail&&<div style={{fontSize:12,color:"#555",marginTop:3}}>{e.detail}</div>}
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
            <span style={{fontSize:10,background:"#f0eeff",color:"#6c5ce7",borderRadius:4,padding:"1px 6px",fontWeight:600}}>{e.board}</span>
            {e.source&&<span style={{fontSize:10,color:"#a25ddc",fontStyle:"italic"}}>{e.source}</span>}
          </div>
        </div>))}
      </div></SidePanel>}
      {updPanel&&updRow&&<SidePanel title={updRow.task} sub="Updates" onClose={()=>setUpdPanel(null)}><div style={{flex:1,overflowY:"auto",padding:16}}>{(updRow.updates||[]).length===0&&<div style={{color:"#aaa",textAlign:"center",padding:30}}>No updates</div>}{(updRow.updates||[]).slice().reverse().map(u=>(<div key={u.id} style={{marginBottom:10,padding:"10px 14px",background:"#f7f8fa",borderRadius:8,borderLeft:"3px solid #0073ea"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontSize:12,fontWeight:600}}>{u.author}</span><span style={{fontSize:11,color:"#999"}}>{u.time}</span></div><div style={{fontSize:13,color:"#444"}}>{u.text}</div></div>))}</div><div style={{padding:16,borderTop:"1px solid #eee"}}><UpdateInput onPost={t=>addUpdate(updPanel.gId,updPanel.rId,t)}/></div></SidePanel>}
      {detailPanel&&detailRow&&<DetailPanel row={detailRow} gId={detailGId} onUpdate={(f,v)=>upRow(detailGId,detailRow.id,f,v)} onAddUpdate={t=>addUpdate(detailGId,detailRow.id,t)} onClose={()=>setDetailPanel(null)} people={people} statuses={statuses} priorities={priorities}/>}
      {notifsOpen&&<NotifsPanel notifs={notifs} setNotifs={setNotifs} onClose={()=>setNotifsOpen(false)}/>}
      {activityOpen&&<ActivityPanel boards={boards} onClose={()=>setActivityOpen(false)}/>}
      {templateModal&&<TemplateModal onSelect={addBoardFromTemplate} onClose={()=>setTemplateModal(false)} boards={boards} mainBoards={boards.filter(b=>b.isMain)}/>}
      {toast&&<Toast msg={toast} onDone={()=>setToast(null)}/>}
      {confirmDel&&<ConfirmModal
        message={confirmDel.type==="bulk"
          ?("This will permanently delete "+confirmDel.count+" selected item"+(confirmDel.count>1?"s":"")+". This cannot be undone.")
          :confirmDel.type==="board"
          ?("Delete the board \""+confirmDel.name+"\" and all its contents? This cannot be undone.")
          :("Delete \""+confirmDel.name+"\"? This cannot be undone.")}
        onConfirm={()=>{if(confirmDel.type==="bulk")bulkDelete();else if(confirmDel.type==="board"){snap();setBoards(bs=>{const nb=bs.filter(b=>b.id!==confirmDel.boardId);setActiveId(nb[0]?.id);return nb;});}else delRow(confirmDel.gId,confirmDel.rId);setConfirmDel(null);}}
        onCancel={()=>setConfirmDel(null)}/>}
      {selCount>0&&board&&<SelectionBar count={selCount} groups={board.groups} statuses={statuses} priorities={priorities} onDuplicate={bulkDuplicate} onDelete={()=>setConfirmDel({type:"bulk",count:selCount})} onMove={bulkMove} onSetStatus={bulkSetStatus} onSetPriority={bulkSetPriority} onDeselect={deselectAll}/>}
      {ctxMenu&&<CtxMenu pos={{x:ctxMenu.x,y:ctxMenu.y}} onClose={()=>setCtxMenu(null)} options={ctxMenu.type==="row"?[
        {icon:"↗",label:"Open details",fn:()=>setDetailPanel({gId:ctxMenu.gId,rId:ctxMenu.rId})},
        {icon:"⊕",label:"Add subitem",fn:()=>{addSubitem(ctxMenu.gId,ctxMenu.rId);setExpandedSub(s=>({...s,[ctxMenu.rId]:true}));}},
        {icon:"⧉",label:"Duplicate",fn:()=>dupRow(ctxMenu.gId,ctxMenu.rId)},
        {divider:true},
        ...((ctxMenu.groups||[]).filter(g=>g.id!==ctxMenu.gId).map(g=>({icon:"→",label:"Move to "+g.name,fn:()=>{setDragRow({gId:ctxMenu.gId,rId:ctxMenu.rId});setTimeout(()=>{setB(bi,b=>{let row;const gs=b.groups.map(gg=>{if(gg.id===ctxMenu.gId){row=gg.rows.find(r=>r.id===ctxMenu.rId);return({...gg,rows:gg.rows.filter(r=>r.id!==ctxMenu.rId)});}return gg;});if(!row)return b;return({...b,groups:gs.map(gg=>gg.id!==g.id?gg:{...gg,rows:[...gg.rows,row]})});});setDragRow(null);},0);}}))),
        {divider:true},
        {icon:"🗑",label:"Delete",danger:true,fn:()=>{const r=board.groups.flatMap(g=>g.rows).find(r=>r.id===ctxMenu.rId);setConfirmDel({type:"row",gId:ctxMenu.gId,rId:ctxMenu.rId,name:r?.task||"this task"});}},
      ]:ctxMenu.type==="board"?[
        {icon:"✎",label:"Rename",fn:()=>{setRnBoard(ctxMenu.boardId);setRnVal(boards.find(b=>b.id===ctxMenu.boardId)?.name||"");}},
        {icon:"⧉",label:"Duplicate board",fn:()=>dupBoard(ctxMenu.boardId)},
        {icon:"📗",label:"Export to Excel",fn:()=>{const b=boards.find(x=>x.id===ctxMenu.boardId);if(b){if(b.isDashboard)exportDashboardToExcel(boards);else if(b.isSummary)exportSummaryToExcel(boards,b.summarySrc||"all");else exportBoardToExcel(b);setToast("📥 Exported \""+b.name+"\"");}}},
        {divider:true},(c=>({icon:CAT_ICONS[c],label:"Move to "+c,fn:()=>moveBoardCat(ctxMenu.boardId,c)})),
        {divider:true},
        {icon:"🗑",label:"Delete board",danger:true,fn:()=>{if(boards.length>1){const bName=boards.find(b=>b.id===ctxMenu.boardId)?.name||"this board";setConfirmDel({type:"board",boardId:ctxMenu.boardId,name:bName});}}}
      ]:[]}/>}
      {colCtx&&<ColCtxMenu pos={{x:colCtx.x,y:colCtx.y}} col={colCtx.addOnly?null:cols.find(c=>c.id===colCtx.colId)} onClose={()=>setColCtx(null)}
        onSort={dir=>{const cid=colCtx.colId==="timeline"?"tlStart":colCtx.colId==="tltype"?"timeline":colCtx.colId==="progress"?"projectProgress":colCtx.colId;doSort(colCtx.gId,cid,dir);}}
        onAddCol={(side,type,label)=>{if(colCtx.addOnly||!colCtx.colId){addColAfter(null,type,label);}else{if(side==="right")addColAfter(colCtx.colId,type,label);else{const ci=cols.findIndex(c=>c.id===colCtx.colId);const beforeId=ci>0?cols[ci-1].id:"__START__";addColAfter(beforeId,type,label);}}}}
        onRename={()=>{if(colCtx.colId){setRnColId(colCtx.colId);setRnColVal(cols.find(c=>c.id===colCtx.colId)?.name||"");}}}
        onHide={()=>{const c=cols.find(x=>x.id===colCtx.colId);if(c)hideCol(c.name);}}
        onDelete={()=>{if(colCtx.colId)delCol(colCtx.colId);}}
        colTypes={COL_TYPES}
      />}
      {syncModal&&board&&<SyncModal board={board} allBoards={wsBoards} onClose={()=>setSyncModal(false)} onAddSync={id=>{addSyncTarget(id);}} onRemoveSync={id=>{removeSyncTarget(id);}}/>}
      {adminOpen&&<AdminPanel teamMembers={teamMembers} setTeamMembers={setTeamMembers} currentUser={currentUser} onClose={()=>setAdminOpen(false)}/>}
      {sharePanel&&board&&<SharePanel board={board} teamMembers={teamMembers} onUpdate={newShared=>{setBoards(bs=>{const n=[...bs];const i=n.findIndex(b=>b.id===activeId);if(i<0)return bs;n[i]={...n[i],shared:newShared};return n;});}} onClose={()=>setSharePanel(false)}/>}
      {wsSharePanel&&<WsSharePanel workspace={workspaces.find(w=>w.id===activeWs)} teamMembers={teamMembers} onUpdate={newShared=>{setWorkspaces(ws=>ws.map(w=>w.id!==activeWs?w:{...w,shared:newShared}));}} onClose={()=>setWsSharePanel(false)}/>}
    </div>
  );
}

const AutoPanel=memo(({autos,setAutos,onClose,boardName})=>{
  const [view,setView]=useState("browse");const [search,setSearch]=useState("");const [catFilter,setCatFilter]=useState("All");
  const cats=["All",...AUTO_RECIPES.reduce((acc,r)=>acc.includes(r.cat)?acc:[...acc,r.cat],[])];
  const filtered=AUTO_RECIPES.filter(r=>(catFilter==="All"||r.cat===catFilter)&&(!search||r.title.toLowerCase().includes(search.toLowerCase())||r.desc.toLowerCase().includes(search.toLowerCase())));
  const isActive=r=>autos.some(a=>a.trigger===r.trigger);
  const toggleRecipe=r=>{if(isActive(r)){setAutos(autos.filter(a=>a.trigger!==r.trigger));}else{setAutos([...autos,{id:uid(),enabled:true,trigger:r.trigger,title:r.title,label:r.desc,cat:r.cat}]);}};
  return(<SidePanel title="⚡ Automations" sub={boardName} onClose={onClose} width={560}>
    <div style={{display:"flex",borderBottom:"1px solid #eee"}}>
      {[["browse","Browse Recipes"],["active","My Automations ("+autos.length+")"]].map(([k,l])=>(<div key={k} onClick={()=>setView(k)} style={{flex:1,padding:"10px 16px",fontSize:13,fontWeight:view===k?600:400,borderBottom:view===k?"2px solid #6c5ce7":"2px solid transparent",cursor:"pointer",color:view===k?"#6c5ce7":"#666",textAlign:"center"}}>{l}</div>))}
    </div>
    {view==="browse"&&<>
      <div style={{padding:"10px 16px",borderBottom:"1px solid #f0f0f0",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search recipes..." style={{border:"1px solid #e0e0e0",borderRadius:6,padding:"5px 10px",fontSize:12,outline:"none",width:160}}/>
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{cats.map(c=>(<button key={c} onClick={()=>setCatFilter(c)} style={{background:catFilter===c?"#6c5ce7":"#f5f6f8",color:catFilter===c?"#fff":"#666",border:"none",borderRadius:16,padding:"3px 10px",fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>{c}</button>))}</div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:16,display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {filtered.map(r=>{const active=isActive(r);return(<div key={r.id} style={{border:"1px solid "+(active?"#6c5ce7":"#e6e9ef"),borderRadius:10,padding:14,background:active?"#f5f3ff":"#fff"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
            <div style={{fontSize:13,fontWeight:700,color:"#333"}}>{r.title}</div>
            {r.popular&&<span style={{background:"#fff8e7",color:"#fdab3d",borderRadius:10,padding:"1px 6px",fontSize:10,fontWeight:700}}>Popular</span>}
          </div>
          <div style={{fontSize:11,color:"#888",marginBottom:10,lineHeight:1.5}}>{r.desc}</div>
          <div style={{fontSize:10,color:"#aaa",marginBottom:8}}>Category: {r.cat}</div>
          <button onClick={()=>toggleRecipe(r)} style={{width:"100%",padding:"6px",border:"none",borderRadius:6,background:active?"#e2445c":"#6c5ce7",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700}}>{active?"Disable":"Enable"}</button>
        </div>);})}
      </div>
    </>}
    {view==="active"&&<div style={{flex:1,overflowY:"auto",padding:16}}>
      {autos.length===0&&<div style={{textAlign:"center",color:"#aaa",padding:40}}>No active automations. Browse recipes to enable some.</div>}
      {autos.map((a,i)=>(<div key={a.id} style={{padding:"14px 16px",background:"#fff",borderRadius:8,marginBottom:8,border:"1px solid #e6e9ef",display:"flex",alignItems:"center",gap:10}}>
        <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>{a.title||a.label}</div><div style={{fontSize:11,color:"#888"}}>{a.label}</div>{a.cat&&<span style={{fontSize:10,background:"#f0f0f0",borderRadius:4,padding:"1px 6px",color:"#666"}}>{a.cat}</span>}</div>
        <Toggle on={a.enabled} onToggle={()=>{const n=[...autos];n[i]={...n[i],enabled:!n[i].enabled};setAutos(n);}}/>
        <span onClick={()=>setAutos(autos.filter(x=>x.id!==a.id))} style={{cursor:"pointer",color:"#ccc",fontSize:14}}>✕</span>
      </div>))}
    </div>}
  </SidePanel>);
});
