/* Hydrate the existing login shell without discarding early user input. */
(function (global) {
  'use strict';
  var assets = JSON.parse(document.getElementById('planning-assets').textContent);
  var ready = false, pending = null, editorPromise = null, adminPromise = null, adminPlansPromise = null, overviewPromise = null, statisticsPromise = null, planStatisticsPromise = null, managementPromise = null, coordinationPromise = null, monthlyPromise = null, libraryPromise = null, passwordPromise = null, planningAIPromise = null, reporterPromises = {}, workflowPromises = {};
  var shell = document.querySelector('[data-initial-login]');
  function act(action, value) {
    if (!ready) { pending = [action, value]; return; }
    if (!document.getElementById('authForm')) return;
    if (action === 'submit') document.getElementById('authForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    else if (action === 'tab') global.App.authTab(value);
    else global.App.forgot();
  }
  if (shell) {
    shell.addEventListener('click', function (event) {
      var button = event.target.closest('[data-login-action]');
      if (button) { event.preventDefault(); act(button.dataset.loginAction, button.dataset.tab); }
    });
    document.getElementById('authForm').addEventListener('submit', function (event) {
      if (!ready) { event.preventDefault(); pending = ['submit']; }
    });
  }
  function script(url) {
    return new Promise(function (resolve, reject) {
      var element = document.createElement('script'); element.src = url;
      element.onload = resolve;
      element.onerror = function () { element.remove(); reject(new Error('组件下载失败，请刷新重试')); };
      document.head.appendChild(element);
    });
  }
  function style(url) {
    return new Promise(function (resolve, reject) {
      var element = document.createElement('link'); element.rel = 'stylesheet'; element.href = url;
      element.onload = resolve;
      element.onerror = function () { element.remove(); reject(new Error('组件样式下载失败，请刷新重试')); };
      document.head.appendChild(element);
    });
  }
  var cloud = global.WorkBuddyCloud.createWorkBuddyCloud();
  global.PlanningBoot = {
    assets: assets,
    ensureMeetingController: function () {
      if (!global.PlanningBoot.meetingPromise) global.PlanningBoot.meetingPromise = Promise.all([style(assets['meeting-mode.css']), script(assets['monthly-summaries.js']), script(assets['meeting-view.js'])])
        .then(function(){return script(assets['meeting-controller.js']);})
        .catch(function(error){global.PlanningBoot.meetingPromise=null;throw error;});
      return global.PlanningBoot.meetingPromise;
    },
    ensureReportReference: function () {
      if (!global.PlanningBoot.reportReferencePromise) global.PlanningBoot.reportReferencePromise = Promise.all([style(assets['report-reference.css']), script(assets['report-reference.js'])])
        .catch(function (error) { global.PlanningBoot.reportReferencePromise = null; throw error; });
      return global.PlanningBoot.reportReferencePromise;
    },
    ensurePlanningAI: function () {
      if(!planningAIPromise)planningAIPromise=Promise.all([style(assets['planning-ai.css']),script(assets['planning-ai-draft.js']),script(assets['planning-ai-memory.js'])])
        .then(function(){return script(assets['planning-ai.js']);}).catch(function(error){planningAIPromise=null;throw error;});
      return planningAIPromise;
    },
    session: cloud.auth.getSession(),
    complete: function () {
      ready = true;
      if (pending) { var action = pending; pending = null; act(action[0], action[1]); }
    },
    ensurePasswordChange: function () {
      if (!passwordPromise) passwordPromise = Promise.all([style(assets['password-change.css']), script(assets['password-change.js'])])
        .catch(function (error) { passwordPromise = null; throw error; });
      return passwordPromise;
    },
    ensureReporter: function (view) {
      var key=view === 'master' ? 'archive' : view === 'mline' ? 'workbench' : 'tasks';
      if (!reporterPromises[key]) {
        var work=key === 'archive' ? [style(assets['reporter-archive.css']),script(assets['reporter-archive.js']),style(assets['project-knowledge.css']),script(assets['project-knowledge.js'])]
          : key === 'workbench' ? [style(assets['reporter-workbench.css'])]
          : [style(assets['reporter-tasks.css']),script(assets['reporter-tasks.js'])];
        if(view === 'center')work.push(global.PlanningBoot.ensureReporter('mline'));
        reporterPromises[key]=Promise.all(work).catch(function(error){delete reporterPromises[key];throw error;});
      }
      if(view === 'center')return Promise.all([reporterPromises[key],global.PlanningBoot.ensureReporter('mline')]);
      return reporterPromises[key];
    },
    ensureWorkflow: function (attachments) {
      var keys = attachments ? ['completion-review', 'report-attachments'] : ['completion-review'];
      return Promise.all(keys.map(function (key) {
        if (!workflowPromises[key]) workflowPromises[key] = Promise.all([style(assets[key + '.css']), script(assets[key + '.js'])])
          .catch(function (error) { delete workflowPromises[key]; throw error; });
        return workflowPromises[key];
      }));
    },
    ensureAdmin: function () {
      if (!adminPromise) adminPromise = Promise.all([global.PlanningBoot.ensureReporter('master'), style(assets['admin-archive.css']), script(assets['admin-archive.js'])])
        .catch(function (error) { adminPromise = null; throw error; });
      return adminPromise;
    },
    ensureOverview: function(){
      if(!overviewPromise)overviewPromise=Promise.all([script(assets['overview-meetings.js']),script(assets['admin-plan-overview.js']),script(assets['monthly-summaries.js']),style(assets['admin-plan-overview.css'])]).catch(function(error){overviewPromise=null;throw error;});
      return overviewPromise;
    },
    ensureStatistics:function(){
      if(!statisticsPromise)statisticsPromise=Promise.all([style(assets['completion-statistics.css']),script(assets['completion-statistics.js'])]).catch(function(error){statisticsPromise=null;throw error;});
      return statisticsPromise;
    },
    ensureProjectPlanStatistics:function(){
      if(!planStatisticsPromise)planStatisticsPromise=Promise.all([style(assets['project-plan-statistics.css']),script(assets['project-plan-statistics.js'])]).catch(function(error){planStatisticsPromise=null;throw error;});
      return planStatisticsPromise;
    },
    ensureManagementReader:function(){
      if(!managementPromise)managementPromise=Promise.all([style(assets['management-reader.css']),script(assets['management-reader.js'])]).catch(function(error){managementPromise=null;throw error;});
      return managementPromise;
    },
    ensureCoordination:function(){
      if(!coordinationPromise)coordinationPromise=script(assets['coordination-workbench.js']).catch(function(error){coordinationPromise=null;throw error;});
      return coordinationPromise;
    },
    ensureMonthlyPlans:function(){
      if(!monthlyPromise)monthlyPromise=script(assets['monthly-plans.js']).catch(function(error){monthlyPromise=null;throw error;});
      return monthlyPromise;
    },
    ensureAdminPlans:function(){
      if(!adminPlansPromise)adminPlansPromise=Promise.all([global.PlanningBoot.ensureEditor(),style(assets['planning-ai.css']),style(assets['admin-plans.css']),script(assets['admin-plans.js'])])
        .catch(function(error){adminPlansPromise=null;throw error;});
      return adminPlansPromise;
    },
    ensureEditor: function () {
      if (global.Quill && global.ZHRichText && global.ZHRichEditor) return Promise.resolve();
      if (!editorPromise) {
        editorPromise = Promise.all([style(assets['vendor/quill/quill.core.css']), style(assets['selection-format.css']), script(assets['vendor/quill/quill.js']), script(assets['rich-text.js'])])
          .then(function () { return script(assets['rich-editor.js']); })
          .catch(function (error) { editorPromise = null; throw error; });
      }
      return editorPromise;
    }
  };
  global.PlanningBoot.ensureProjectLibrary=function(){
    if(!libraryPromise)libraryPromise=Promise.all([style(assets['project-library.css']),script(assets['project-library.js'])]).catch(function(error){libraryPromise=null;throw error;});
    return libraryPromise;
  };
  script(assets['planning-windows.js']).then(function(){return Promise.all([script(assets['report-scopes.js']),script(assets['baseline-core.js'])]);}).then(function(){return script(assets['app.js']);}).catch(function () {
    var message = document.getElementById('msg');
    if (message) { message.className = 'authmsg err'; message.textContent = '页面组件加载失败，请刷新重试。'; }
  });
})(window);
