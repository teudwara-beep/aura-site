'use strict';

// Exercise the actual public/admin form functions with DOM doubles; API tests live in smoke.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const elements = new Map();
function $(key) {
  if (!elements.has(key)) elements.set(key, {value:'',innerHTML:'',isConnected:true,hidden:false,disabled:false,
    checkValidity:() => true});
  return elements.get(key);
}
const seen = [], notices = [];
const panel = $('#adminPanel');
const context = vm.createContext({
  $, URL, console,
  document:{addEventListener(){}},
  location:{origin:'http://public.aura.test',hash:'#watch=7'},
  views:{watch:{hidden:false}}, getVideo:id => ({id,t:'Sample'}),
  openModal:options => seen.push(options),
  toast:(...args) => notices.push(args),
  esc:value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
  api:async (endpoint, options) => { seen.push({endpoint,options}); return {reference:'AUR-9'}; },
  DATA:{videos:[{id:7,hasFile:true}]},
  adminTab:'reports',reportsStatus:'all',reportsPage:1,
  openAdminPreview(){},closeModal(){},renderAdminView:async () => {}
});
const publicStart = source.indexOf('function videoIdFromReportInput(value){');
vm.runInContext(source.slice(publicStart, source.indexOf('\n/* ===', publicStart)), context);
assert.equal(context.videoIdFromReportInput('http://public.aura.test/#watch=7'), 7);
assert.equal(context.videoIdFromReportInput('http://evil.test/#watch=7'), null);
assert.equal(context.videoIdFromReportInput('7'), 7);
context.openRemovalRequest({id:7,t:'Sample'});
assert.match(seen[0].body, /#watch=7/);
$('#reportVideo').value = 'http://public.aura.test/#watch=7';
$('#reportReason').value = 'privacy'; $('#reportName').value = 'A viewer';
$('#reportEmail').value = 'viewer@example.test';
$('#reportDetails').value = 'I have a privacy concern about this video.';

async function run(){
  await $('#reportSubmit').onclick();
  const submission = seen.find(item => item.endpoint === '/api/reports');
  assert.equal(JSON.parse(submission.options.body).videoId, 7);
  assert.match($('#modalBody').innerHTML, /AUR-9/);
  assert.ok(!notices.some(item => item[1] === 'error'));

  const adminStart = source.indexOf('async function renderAdminReports(panel){');
  vm.runInContext(source.slice(adminStart, source.indexOf('\nasync function renderAdminStorage', adminStart)), context);
  const report = {id:9,video_id:7,original_video_id:7,video_title:'<script>bad</script>',reason:'privacy',
    reporter_name:'<img src=x>',reporter_email:'viewer@example.test',details:'<svg onload=bad()>',status:'new',
    admin_note:'',video_status:'live',created_at:Date.now()};
  context.api = async (endpoint, options) => {
    seen.push({endpoint,options});
    if (endpoint.startsWith('/api/admin/reports?')) return {reports:[report],pagination:{page:1,total:1,hasMore:false}};
    return {ok:true};
  };
  await context.renderAdminReports(panel);
  const rendered = $('#reportsList').innerHTML;
  assert.ok(rendered.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(rendered.includes('&lt;svg onload=bad()&gt;'));
  assert.ok(!rendered.includes('<script>') && !rendered.includes('<svg onload'));
  context.openReportReview(report,'unpublish');
  $('#reportAdminNote').value = 'Content needs private consent review.';
  await $('#reportReviewSave').onclick();
  assert.ok(seen.some(item => item.endpoint === '/api/admin/reports/9/unpublish' && item.options.method === 'POST'));
  console.log('Removal UI checks passed: public link validation/submission, escaped private inbox, and admin unpublish action.');
}
run().catch(error => {console.error(error);process.exitCode=1;});
