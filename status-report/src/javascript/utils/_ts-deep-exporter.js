/*
 * given a set of records, go get more information for them
 */
 
Ext.define('CA.techservices.DeepExporter',{
    config: {
        /*
         * An array of records
         */
        records: [],
        MilestonesByOID: {}
    },
    
    constructor: function(config) {
        config = config || {};
        this.mergeConfig(config);
    },
    
    gatherDescendantInformation: function() {
        var me = this,
            records = this.records;
        // assume that the row represents a portfolio item of some sort
        
        var promises = Ext.Array.map(records, function(record){
            return function() {
                return me.gatherDescendantsForPI(record);
            }
        });
        
        return Deft.Chain.sequence(promises,this)
    },
    
    gatherDescendantsForPI: function(record) {
        var me = this,
            deferred = Ext.create('Deft.Deferred');
        
        me.gatherStoriesForPI(record).then({
            success: function(stories) {
                record.set('_stories',stories);
                
                var rows = [ record.getData() ];
                Ext.Array.each(stories, function(story){
                    var row = Ext.clone(record.getData());
                    row.Story = story;
                    rows.push(row);
                });
                
                deferred.resolve(rows);
            },
            failure: function(msg){
                deferred.reject(msg);
            }
        });
        
        return deferred.promise;
    },
    
    gatherStoriesForPI: function(record) {
        var me = this,
            deferred = Ext.create('Deft.Deferred');
        
        var filters = Rally.data.wsapi.Filter.or([
            {property:'Feature.ObjectID',value:record.get('ObjectID')},
            {property:'Feature.Parent.ObjectID',value:record.get('ObjectID')}
        ]);
        
        var config = {
            model:'HierarchicalRequirement',
            filters: filters,
            limit: Infinity,
            pageSize: 2000,
            fetch: ['ObjectID','FormattedID','Name','Description','c_AcceptanceCriteria',
                'Color','Project','Owner','Iteration','Release','Milestones','Expedite',
                'PlanEstimate','ScheduleState','Ready','TaskEstimateTotal','Defects'
            ]
        };
        
        this._loadWsapiRecords(config).then({
            success: function(stories) {
                var promises = [];
                Ext.Array.each(stories, function(story){
                    promises.push(function() { return me._getTestCasesForStory(story.getData()); });
                });
                
                Deft.Chain.sequence(promises,this).then({
                    success: function(results) {
                        var stories = Ext.Array.flatten(results);
                        
                        if ( stories.length == 0 ) {
                            deferred.resolve(stories);
                            return;
                        }
                        
                        var promises = Ext.Array.map(stories, function(story){
                            return function() {
                                return me._setMilestonesOnStory(story); 
                            }
                        });
                        
                        Deft.Chain.sequence(promises,me).then({
                            success: function(stories_with_milestones) {
                                deferred.resolve(Ext.Array.flatten(stories_with_milestones));
                            },
                            failure: function(msg) {
                                deferred.reject(msg);
                            }
                        });
                        
                        
                    },
                    failure: function(msg) {
                        deferred.reject(msg);
                    }
                
                });
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        
        return deferred.promise;
    },
    
    _setMilestonesOnStory:function(story_data){
        var me = this,
            deferred = Ext.create('Deft.Deferred');
        
        story_data._milestones = [];
        
        if ( Ext.isEmpty(story_data.Milestones) || story_data.Milestones.Count === 0 ) {
            return story_data;
        }
        
        var filters = Ext.Array.map(story_data.Milestones._tagsNameArray, function(ms){
            var oid = me._getOidFromRef(ms._ref);
            return { property:'ObjectID', value: oid };
        });
        
        if ( filters.length === 0 ) { return story_data; }
        
        var config = {
            model:'Milestone',
            filters: Rally.data.wsapi.Filter.or(filters),
            limit: Infinity,
            pageSize: 2000,
            fetch: ['ObjectID','Name','TargetDate']
        };
        
        this._loadWsapiRecords(config).then({
            success: function(milestones) {
                var ms_data = Ext.Array.map(milestones, function(milestone){ return milestone.getData(); });
                
                story_data._milestones = ms_data;
                deferred.resolve(story_data);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        return deferred.promise;
    },
    
    _getOidFromRef: function(ref) {
        var ref_array = ref.replace(/\.js$/,'').split(/\//);
        return ref_array[ref_array.length-1];
    },
    
    _getTestCasesForStory: function(story_data){
        var deferred = Ext.create('Deft.Deferred');
        
        var story_oid = story_data.ObjectID;
        var config = {
            model:'TestCase',
            filters: [{property:'WorkProduct.ObjectID',value:story_oid}],
            limit: Infinity,
            pageSize: 2000,
            fetch: ['ObjectID','FormattedID','Name','Type','LastVerdict']
        };
        
        this._loadWsapiRecords(config).then({
            success: function(testcases) {
                story_data._testcases = testcases;
                story_data._testcasecount_executed = 0;
                story_data._testcasecount_uat = 0;
                story_data._testcasecount_uat_executed = 0;
                Ext.Array.each(testcases, function(testcase){
                    var type = testcase.get('Type');
                    var verdict = testcase.get('LastVerdict');
                    if ( type == 'User Acceptance Testing' ) {
                        story_data._testcasecount_uat = story_data._testcasecount_uat + 1;
                    }
                    
                    if ( !Ext.isEmpty(verdict) ) {
                        story_data._testcasecount_executed = story_data._testcasecount_executed + 1 ;
                    }
                    
                    if (!Ext.isEmpty(verdict) && type == 'User Acceptance Testing' ) {
                        story_data._testcasecount_uat_executed = story_data._testcasecount_uat_executed + 1;
                    }
                });
                
                deferred.resolve(story_data);
                
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        
        return deferred.promise;
    },
     
    _loadWsapiRecords: function(config){
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        var default_config = {
            model: 'Defect',
            fetch: ['ObjectID'],
            compact: false
        };

        Ext.create('Rally.data.wsapi.Store', Ext.Object.merge(default_config,config)).load({
            callback : function(records, operation, successful) {
                if (successful){
                    deferred.resolve(records);
                } else {
                    me.logger.log("Failed: ", operation);
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    // given an array of hashes.  TODO: get columns from the app instead of here
    saveCSV: function(rows, file_name) {
        var me = this;
        
        var csv = Ext.Array.map(rows, function(row){
            return me.getCSVFromRow(row,me.getColumns());
        });
        
        csv.unshift(this.getHeadersFromColumns(this.getColumns()));
        
        csv = csv.join('\r\n');
        Rally.technicalservices.FileUtilities.saveCSVToFile(csv,file_name);
    },
    
    getCSVFromRow: function(row, columns) {
        var nodes = Ext.Array.map(columns, function(column){
            if ( Ext.isEmpty(column.fieldName) ) {
                return '';
            }
            
            var value = row[column.fieldName];
            
            if ( !Ext.isEmpty(column.renderer) ) {
                value = column.renderer(value,row);
            }
            
            if ( Ext.isEmpty(value) ) { return ""; }
            if ( Ext.isString(value) ) { return value.replace(/"/g,'""'); }
            
            return value
        });
        
        var csv_string = "";
        Ext.Array.each(nodes, function(node,idx){
            if ( idx > 0 ) {
                csv_string = csv_string + ",";
            }
            if (/^=/.test(node) ) {
                csv_string = csv_string + node;
            } else {
                csv_string = csv_string + '"' + node + '"';
            }

        });
        
        return csv_string;
    },
    
    getHeadersFromColumns: function(columns) {
        var nodes = Ext.Array.map(columns, function(column){
            return column.text;
        });
         
        var csv_string = "";
        Ext.Array.each(nodes, function(node,idx){
            if ( idx > 0 ) {
                csv_string = csv_string + ",";
            }
            if (/^=/.test(node) ) {
                csv_string = csv_string + node;
            } else {
                csv_string = csv_string + '"' + node + '"';
            }

        });
        
        return csv_string;
        
    },
    
    getColumns: function() {
        // NOT for models -- it's for a hash
        var columns = [];
        
        columns = Ext.Array.push(columns,this._getGrandparentColumns());
        columns = Ext.Array.push(columns,this._getParentColumns());
        columns = Ext.Array.push(columns,this._getItemColumns());
        columns = Ext.Array.push(columns,this._getStoryColumns());
        
        return columns;
    },
    
    _getStoryColumns: function() {
        return [
            {fieldName: 'Story', text: 'Story.FormattedID', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.FormattedID;
            }},
            {fieldName: 'Story', text: 'Story.Name', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.Name;
            }},
            {fieldName: 'Story', text: 'Story.ScheduleState', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ScheduleState) ) { return ""; }
                
                return value.ScheduleState;
            }},
            {fieldName: 'Story', text: 'Story.Description', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Description) ) { return ""; }
                
                return value.Description;
            }},
            {fieldName: 'Story', text: 'Story.Ready', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Ready) ) { return "false"; }
                
                return value.Ready;
            }},
            {fieldName: 'Story', text: 'Story.Color', renderer: function(value,record){
                if (Ext.isEmpty(value) ) { return ""; }
                
                return value.DisplayColor;
            }},
            {fieldName: 'Story', text: 'Story.Project', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Project) ) { return ""; }
                return value.Project.Name;
            }},
            {fieldName: 'Story', text: 'Story.Owner', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Owner) ) { return ""; }
                return value.Owner._refObjectName;
            }},
            {fieldName: 'Story', text: 'Story.Iteration', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Iteration) ) { return ""; }
                return value.Iteration.Name;
            }},
            {fieldName: 'Story', text: 'Story.Release', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Release) ) { return ""; }
                return value.Release.Name;
            }},
            {fieldName: 'Story', text: 'Story.Expedite', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Expedite) ) { return "false"; }
                return value.Expedite;
            }},
            {fieldName: 'Story', text: 'Story.PlanEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PlanEstimate) ) { return "false"; }
                return value.PlanEstimate;
            }},
            {fieldName: 'Story', text: 'Story.AcceptanceCriteria', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_AcceptanceCriteria) ) { return ""; }
                return value.c_AcceptanceCriteria;
            }},
            {fieldName: 'Story', text: 'Story.TaskEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.TaskEstimateTotal) ) { return ""; }
                return value.TaskEstimateTotal;
            }},
            {fieldName: 'Story', text: 'Story.ExecutedTestCaseCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value._testcasecount_executed;
            }},
            {fieldName: 'Story', text: 'Story.UATTestCaseCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value._testcasecount_uat;
            }},
            {fieldName: 'Story', text: 'Story.ExecutedUATTestCaseCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value._testcasecount_uat_executed;
            }},
            {fieldName: 'Story', text: 'Story.Defects', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Defects) ) { return ""; }
                return value.Defects.Count;
            }},
            {fieldName: 'Story', text: 'Story.Milestones', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value._milestones) ) { return ""; }
                
                var display_array = Ext.Array.map(value._milestones, function(ms) {
                    var d = ms.TargetDate;
                    if ( !Ext.isEmpty(d) && ! Ext.isString(d) ) {
                        d = '- ' + Ext.Date.format(d, 'd-M-Y T');
                    }
                    return Ext.String.format("{0} {1}",
                        ms.Name,
                        d || ''
                    );
                });
                
                return display_array.join('| ');
            }}
            
                
        ];
    },
    
    _getItemColumns: function() {
        var me = this;
        return [
            {fieldName: 'Item', text: 'Feature.FormattedID', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.FormattedID;
            }},
            {fieldName: 'Item', text: 'Feature.Name', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.Name;
            }},
            {fieldName: 'Item', text: 'Feature.State', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.State) ) { return ""; }
                
                return value.State.Name;
            }},
            {fieldName: 'Item', text: 'Feature.Description', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Description) ) { return ""; }
                
                return value.Description;
            }},
            {fieldName: 'Item', text: 'Feature.PreliminaryEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PreliminaryEstimate) ) { return ""; }
                
                return value.PreliminaryEstimate.Name;
            }},
            {fieldName: 'Item', text: 'Feature.Ready', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Ready) ) { return "false"; }
                
                return value.Ready;
            }},
            {fieldName: 'Item', text: 'Feature.PercentDoneByStoryPlanEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PercentDoneByStoryPlanEstimate) ) { return ""; }
                
                return Ext.String.format( "{0}%", value.PercentDoneByStoryPlanEstimate * 100 );
            }},
            {fieldName: 'Item', text: 'Feature.PercentDoneByStoryCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PercentDoneByStoryCount) ) { return ""; }
                
                return Ext.String.format( "{0}%", value.PercentDoneByStoryCount * 100 );
            }},
            {fieldName: 'Item', text: 'Feature.Color', renderer: function(value,record){
                if (Ext.isEmpty(value) ) { return ""; }
                
                return value.DisplayColor;
            }},
            {fieldName: 'Item', text: 'Feature.Project', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Project) ) { return ""; }
                return value.Project.Name;
            }},
            {fieldName: 'Item', text: 'Feature.Owner', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Owner) ) { return ""; }
                return value.Owner._refObjectName;
            }},
            {fieldName: 'Item', text: 'Feature.InvestmentCategory', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.InvestmentCategory) ) { return ""; }
                return value.InvestmentCategory;
            }},
            {fieldName: 'Item', text: 'Feature.ValueScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ValueScore) ) { return ""; }
                return value.ValueScore;
            }},
            {fieldName: 'Item', text: 'Feature.RiskScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.RiskScore) ) { return ""; }
                return value.RiskScore;
            }},
            {fieldName: 'Item', text: 'Feature.WSJFScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.WSJFScore) ) { return ""; }
                return value.WSJFScore;
            }},
            {fieldName: 'Item', text: 'Feature.RefinedEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.RefinedEstimate) ) { return ""; }
                return value.RefinedEstimate;
            }},
            {fieldName: 'Item', text: 'Feature.PlannedStartDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PlannedStartDate) ) { return ""; }
                return value.PlannedStartDate;
            }},
            {fieldName: 'Item', text: 'Feature.PlannedEndDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PlannedEndDate) ) { return ""; }
                return value.PlannedEndDate;
            }},
            {fieldName: 'Item', text: 'Feature.ActualStartDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ActualStartDate) ) { return ""; }
                return value.ActualStartDate;
            }},
            {fieldName: 'Item', text: 'Feature.ActualEndDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ActualEndDate) ) { return ""; }
                return value.ActualEndDate;
            }},
            {fieldName: 'Item', text: 'Feature.Release.Name', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Release) ) { return ""; }
                return value.Release.Name;
            }},
            {fieldName: 'Item', text: 'Feature.Release.StartDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Release) ) { return ""; }
                return value.Release.ReleaseStartDate;
            }},
            {fieldName: 'Item', text: 'Feature.Release.EndDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Release) ) { return ""; }
                return value.Release.ReleaseDate;
            }},
            {fieldName: 'Item', text: 'Feature.Expedite', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Expedite) ) { return "false"; }
                return value.Expedite;
            }},
            {fieldName: 'Item', text: 'Feature.CapabilityType', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_CapabilityType) ) { return ""; }
                return value.c_CapabilityType;
            }},
            {fieldName: 'Item', text: 'Feature.PlatformCapability', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_PlatformCapability) ) { return ""; }
                return value.c_PlatformCapability;
            }},
            {fieldName: 'Item', text: 'Feature.AcceptanceCriteria', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_AcceptanceCriteria) ) { return ""; }
                return value.c_AcceptanceCriteria;
            }},
            {fieldName: 'Item', text: 'Feature.LeafStoryCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.LeafStoryCount) ) { return ""; }
                return value.LeafStoryCount;
            }},
            {fieldName: 'Item', text: 'Feature.Milestones', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Milestones) || value.Milestones.Count === 0) { return ""; }
                
                return Ext.Array.map(value.Milestones._tagsNameArray, function(ms){
                    var oid = me._getOidFromRef(ms._ref);
                    var d = me.MilestonesByOID[oid] &&  me.MilestonesByOID[oid].get('TargetDate');
                                        
                    if ( !Ext.isEmpty(d) ) {
                        d = '- ' + Ext.Date.format(d, 'd-M-Y T');
                    }
                    return Ext.String.format("{0} {1}",
                        ms.Name,
                        d || ''
                    );
                }).join('| ');
            }},
            {fieldName: 'Item', text: 'Feature.DependenciesCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PredecessorsAndSuccessors) ) { return ""; }
                
                return value.PredecessorsAndSuccessors.Count;
            }}
        ];
    },
    
    _getParentColumns: function() {
        var me = this;
        return [
            {fieldName: 'Parent', text: 'Feature.Parent.FormattedID', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.FormattedID;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Name', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.Name;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.State', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.State) ) { return ""; }
                
                return value.State.Name;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Description', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Description) ) { return ""; }
                
                return value.Description;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.PreliminaryEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PreliminaryEstimate) ) { return ""; }
                
                return value.PreliminaryEstimate.Name;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Ready', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Ready) ) { return "false"; }
                
                return value.Ready;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.PercentDoneByStoryPlanEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PercentDoneByStoryPlanEstimate) ) { return ""; }
                
                return Ext.String.format( "{0}%", value.PercentDoneByStoryPlanEstimate * 100 );
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.PercentDoneByStoryCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PercentDoneByStoryCount) ) { return ""; }
                
                return Ext.String.format( "{0}%", value.PercentDoneByStoryCount * 100 );
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Color', renderer: function(value,record){
                if (Ext.isEmpty(value) ) { return ""; }
                
                return value.DisplayColor;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Project', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Project) ) { return ""; }
                return value.Project.Name;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Owner', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Owner) ) { return ""; }
                return value.Owner._refObjectName;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.InvestmentCategory', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.InvestmentCategory) ) { return ""; }
                return value.InvestmentCategory;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.ValueScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ValueScore) ) { return ""; }
                return value.ValueScore;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.RiskScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.RiskScore) ) { return ""; }
                return value.RiskScore;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.WSJFScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.WSJFScore) ) { return ""; }
                return value.WSJFScore;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.RefinedEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.RefinedEstimate) ) { return ""; }
                return value.RefinedEstimate;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.PlannedStartDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PlannedStartDate) ) { return ""; }
                return value.PlannedStartDate;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.PlannedEndDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PlannedEndDate) ) { return ""; }
                return value.PlannedEndDate;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.ActualStartDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ActualStartDate) ) { return ""; }
                return value.ActualStartDate;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.ActualEndDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ActualEndDate) ) { return ""; }
                return value.ActualEndDate;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Expedite', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Expedite) ) { return "false"; }
                return value.Expedite;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.CapabilityType', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_CapabilityType) ) { return ""; }
                return value.c_CapabilityType;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.PlatformCapability', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_PlatformCapability) ) { return ""; }
                return value.c_PlatformCapability;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.AcceptanceCriteria', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_AcceptanceCriteria) ) { return ""; }
                return value.c_AcceptanceCriteria;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.LeafStoryCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.LeafStoryCount) ) { return ""; }
                return value.LeafStoryCount;
            }},
            {fieldName: 'Parent', text: 'Feature.Parent.Milestones', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Milestones) || value.Milestones.Count === 0) { return ""; }
                
                return Ext.Array.map(value.Milestones._tagsNameArray, function(ms){
                    var oid = me._getOidFromRef(ms._ref);
                    var d = me.MilestonesByOID[oid] &&  me.MilestonesByOID[oid].get('TargetDate');
                                        
                    if ( !Ext.isEmpty(d) ) {
                        d = '- ' + Ext.Date.format(d, 'd-M-Y T');
                    }
                    return Ext.String.format("{0} {1}",
                        ms.Name,
                        d || ''
                    );
                }).join('| ');
            }},
            {fieldName: 'Item', text: 'Feature.Parent.DependenciesCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PredecessorsAndSuccessors) ) { return ""; }
                
                return value.PredecessorsAndSuccessors.Count;
            }}
        ];
    },
    
    _getGrandparentColumns: function() {
        var me = this;
        return [
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.FormattedID', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.FormattedID;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Name', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.Name;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.State', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.State) ) { return ""; }
                
                return value.State.Name;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.PreliminaryEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PreliminaryEstimate) ) { return ""; }
                
                return value.PreliminaryEstimate.Name;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Ready', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Ready) ) { return "false"; }
                
                return value.Ready;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.PercentDoneByStoryPlanEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PercentDoneByStoryPlanEstimate) ) { return ""; }
                
                return Ext.String.format( "{0}%", value.PercentDoneByStoryPlanEstimate * 100 );
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.PercentDoneByStoryCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PercentDoneByStoryCount) ) { return ""; }
                
                return Ext.String.format( "{0}%", value.PercentDoneByStoryCount * 100 );
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Color', renderer: function(value,record){
                if (Ext.isEmpty(value) ) { return ""; }
                
                return value.DisplayColor;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Description', renderer: function(value,record){                
                if (Ext.isEmpty(value) ) { return ""; }
                return value.Description;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Project', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Project) ) { return ""; }
                return value.Project.Name;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Owner', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Owner) ) { return ""; }
                return value.Owner._refObjectName;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.InvestmentCategory', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.InvestmentCategory) ) { return ""; }
                return value.InvestmentCategory;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.ValueScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ValueScore) ) { return ""; }
                return value.ValueScore;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.RiskScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.RiskScore) ) { return ""; }
                return value.RiskScore;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.WSJFScore', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.WSJFScore) ) { return ""; }
                return value.WSJFScore;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.RefinedEstimate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.RefinedEstimate) ) { return ""; }
                return value.RefinedEstimate;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.PlannedStartDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PlannedStartDate) ) { return ""; }
                return value.PlannedStartDate;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.PlannedEndDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PlannedEndDate) ) { return ""; }
                return value.PlannedEndDate;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.ActualStartDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ActualStartDate) ) { return ""; }
                return value.ActualStartDate;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.ActualEndDate', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.ActualEndDate) ) { return ""; }
                return value.ActualEndDate;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Expedite', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Expedite) ) { return "false"; }
                return value.Expedite;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.CapabilityType', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_CapabilityType) ) { return ""; }
                return value.c_CapabilityType;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.PlatformCapability', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.c_PlatformCapability) ) { return ""; }
                return value.c_PlatformCapability;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.LeafStoryCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.LeafStoryCount) ) { return ""; }
                return value.LeafStoryCount;
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.Milestones', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.Milestones) || value.Milestones.Count === 0) { return ""; }
                
                return Ext.Array.map(value.Milestones._tagsNameArray, function(ms){
                    var oid = me._getOidFromRef(ms._ref);
                    var d = me.MilestonesByOID[oid] &&  me.MilestonesByOID[oid].get('TargetDate');
                                        
                    if ( !Ext.isEmpty(d) ) {
                        d = '- ' + Ext.Date.format(d, 'd-M-Y T');
                    }
                    return Ext.String.format("{0} {1}",
                        ms.Name,
                        d || ''
                    );
                }).join('| ');
            }},
            {fieldName: 'Grandparent', text: 'Feature.Parent.PortfolioItem.DependenciesCount', renderer: function(value,record){                
                if (Ext.isEmpty(value) || Ext.isEmpty(value.PredecessorsAndSuccessors) ) { return ""; }
                
                return value.PredecessorsAndSuccessors.Count;
            }}
        ];
    }
    
    
});