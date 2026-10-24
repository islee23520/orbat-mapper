import assert from "node:assert/strict";
import test from "node:test";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { graphSemanticProjection } from "./graph-store.mjs";
import { observedGeographySemanticProjection } from "./observed-geography-store.mjs";
import { validateAuthoringCommands, applyAuthoringCommands } from "./command-validate.mjs";

const H = c => c.repeat(64);
const ref = (entityKind, sourceId, datasetId = "synthetic:author", editionId = "base") => ({ datasetId, editionId, entityKind, sourceId });
const station = id => ref("graph-station", id, "synthetic:graph", "g1");
const person = id => ref("person", id, "synthetic:identity", "i1");
const receipt = {contentId:"source-review",sha256:H("a")};
function seal(a) {
  const {semanticSha256, ...p} = a;
  a.semanticSha256 = semanticDigest({...p,edgeChanges:a.edgeChanges.map(({sourceReceipt,...r})=>r),crosswalkChanges:a.crosswalkChanges.map(({sourceReceipt,...r})=>r)});
  return a;
}
function sourceFixture() {
  const document = {schema:"seoul-world-graph-v2",districts:["district"],
    stations:["a","b","c"].map(id=>({id,nameKo:id,nameEn:id,district:"district",lat:37,lon:127})),
    edges:[{a:"a",b:"b"}],aliases:{z:"b",a:"a"},source:{original:"synthetic",railAdjacency:{
      revision:"synthetic",officialSource:{url:"https://example.invalid",retrievedAt:"2025-01-01",sha256:H("a"),scope:"synthetic"},
      WikiCommit:"synthetic",scope:"synthetic",replacements:[],excluded:[],hubIdentities:[]}}};
  const graph = {datasetId:"synthetic:graph",editionId:"g1",document};
  graph.graphSemanticSha256 = semanticDigest(graphSemanticProjection(graph));
  const rows = {
    boundary_geometry_source:[{source_path:"synthetic/geometry",sha256:H("a"),collection_type:"FeatureCollection"}],
    boundary_geometry_feature:[],boundary_geometry_property:[],boundary_geometry_dong:[{feature_id:"county",ordinal:0,code:"001"}],
    boundary_geometry_gu:[{feature_id:"county",ordinal:0,gu_ref:"gu"}],boundary_geometry_polygon:[],boundary_geometry_ring:[],boundary_geometry_point:[],
    geography_spatial:[{singleton:1,edition:"o1",baseDate:"2025-06-30",authority:"official-SGIS-statistical-boundary",legalSurveyCertification:0,current2026Geometry:0,archiveSha256:H("b")}],
    geography_spatial_geometry:[{singleton:1,path:"synthetic/geometry",sha256:H("a"),crs:"OGC:CRS84",features:4}],
    geography_county:[{edition:"dated",countyTitleId:"county",ordinal:0}],
    geography_slot:[{edition:"dated",countyTitleId:"county",ordinal:0,slotId:"slot",dongId:"dong",name:"Dong",jurisdictionGuRef:"gu",electoralDongId:"electoral",fragmentId:null,sourceEdition:"o1",sourcePointer:"/synthetic/0",geometryVerified:1}],
    geography_slot_source:[{edition:"dated",slotId:"slot",ordinal:0,ref:"source"}],geography_slot_geometry:[{edition:"dated",slotId:"slot",ordinal:0,ref:"dong"}],
    geography_edition:[{kind:"electoral",id:"electoral-edition",electionDate:"2024-04-10",seoulCompositionMatchesCurrentAppendix:1}],
    geography_edition_source:[{kind:"electoral",ordinal:0,ref:"source"}],geography_source_record:[{ordinal:3,id:"source",sha256:H("c"),role:"membership"}],
    geography_evidence:[{kind:"membership",path:"synthetic/membership",sha256:H("d")},{kind:"spatial",path:"synthetic/spatial",sha256:H("e")}]
  };
  const definitions = [["dong","dong",{officialCode:"001",officialName:"Dong",dongId:"dong",electoralDongId:"electoral",countyTitleId:"county",guId:"gu"}],
    ["county","county",{countyTitleId:"county",name:"County",officialDongCodes:["001"],jurisdictionGuRefs:["gu"]}],
    ["gu","gu",{guId:"gu",name:"Gu"}],["city","city",{officialCode:"11"}]];
  const mapping={kind:"kind",sourceEdition:"source_edition",officialCode:"official_code",officialName:"official_name",dongId:"dong_id",electoralDongId:"electoral_dong_id",countyTitleId:"county_title_id",guId:"gu_id",name:"name"};
  const features = [];
  definitions.forEach(([id,kind,properties],ordinal)=>{
    const feature={id,ordinal,feature_type:"Feature",geometry_type:id==="dong"?"MultiPolygon":"Polygon",kind,source_edition:"o1",official_code:null,official_name:null,dong_id:null,electoral_dong_id:null,county_title_id:null,gu_id:null,name:null};
    for(const [k,v] of Object.entries(properties)) if(mapping[k]) feature[mapping[k]]=v;
    rows.boundary_geometry_feature.push(feature);
    const allProperties={kind,sourceEdition:"o1",...properties};
    Object.keys(allProperties).forEach((name,ordinal)=>rows.boundary_geometry_property.push({feature_id:id,ordinal,name}));
    const outer=[[127,37],[127.5,37],[127.5,37.5],[127,37]],hole=[[127.1,37.1],[127.2,37.1],[127.2,37.2],[127.1,37.1]];
    const polygons=id==="dong"?[[outer,hole],[outer]]:[[outer]];
    polygons.forEach((rings,p)=>{
      rows.boundary_geometry_polygon.push({feature_id:id,ordinal:p});
      rings.forEach((points,r)=>{
        rows.boundary_geometry_ring.push({feature_id:id,polygon_ordinal:p,ordinal:r});
        points.forEach(([longitude,latitude],ordinal)=>rows.boundary_geometry_point.push({feature_id:id,polygon_ordinal:p,ring_ordinal:r,ordinal,longitude,latitude}));
      });
    });
    features.push({type:"Feature",id,properties:allProperties,geometry:{type:feature.geometry_type,coordinates:id==="dong"?polygons:polygons[0]}});
  });
  const observedGeography={datasetId:"synthetic:observed",editionId:"o1",rows,geometry:{type:"FeatureCollection",features}};
  observedGeography.observedGeographySemanticSha256=semanticDigest(observedGeographySemanticProjection({datasetId:"synthetic:observed",editionId:"o1",rows}));
  const central={schema:"janseon-central-snapshot.v1",graph,observedGeography};
  central.centralSemanticSha256=semanticDigest({schema:"janseon-central-semantic.v1",graph:{datasetId:graph.datasetId,editionId:graph.editionId,semanticSha256:graph.graphSemanticSha256},observedGeography:{datasetId:observedGeography.datasetId,editionId:observedGeography.editionId,semanticSha256:observedGeography.observedGeographySemanticSha256}});
  return central;
}
function authoredFixture(central, identityHash=H("1")) {
  return seal({schema:"janseon-authored-edition.v1",datasetId:"synthetic:author",editionId:"base",baseCentralSemanticSha256:central.centralSemanticSha256,identitySnapshotSha256:identityHash,
    entities:[{ref:ref("authored-facility","f"),geographicParentRef:null,location:null,footprint:null},{ref:ref("authored-settlement","s"),geographicParentRef:null,location:null,footprint:null}],
    geometries:[],edgeChanges:[],crosswalkChanges:[],assignments:[],tombstones:[]});
}

function fixture() {
  const central=sourceFixture(), authored=authoredFixture(central);
  const identity={snapshotSha256:H("1"),entities:["a","b"].map(id=>({ref:person(id),affiliationRefs:[],affiliationStatus:"none"}))};
  identity.entities.push({ref:ref("polity","p","synthetic:identity","i1"),affiliationRefs:[],affiliationStatus:"none"});
  return {schema:"janseon-authoring-context.v1",generationId:H("2"),mapSemanticSha256:H("3"),identitySnapshotSha256:H("1"),central,authored,baseline:structuredClone(authored),identity,
    referenceEntities:[{ref:ref("title","t","synthetic:titles","t1"),role:"title"}],sourceReceipts:[receipt],review:{receipt,inputSha256:H("0"),permittedKinds:[],sourceReceipts:[receipt]},replay:null};
}
const overlay = id=>({geometryRef:ref("authored-geometry",id),ownerRef:ref("authored-facility","f"),geometry:{crs:"OGC:CRS84",type:"Point",coordinates:[127,37]}});
const edge = id=>({changeRef:ref("authored-edge-change",id),baseEdgeRef:null,a:station("b"),b:station("c"),sourceReceipt:receipt});
const cross = id=>({crosswalkRef:ref("authored-crosswalk",id),stationRef:station("a"),facilityRef:ref("authored-facility","f"),sourceReceipt:receipt});
function op(kind,args) {
  const refs=new Map(); function visit(v){if(v&&typeof v==="object"){if(Object.hasOwn(v,"entityKind"))refs.set(JSON.stringify([v.datasetId,v.editionId,v.entityKind,v.sourceId]),v);else Object.values(v).forEach(visit);}} visit(args);
  return {kind,args,editionId:"base",targetEntityRefs:[...refs.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,r])=>r)};
}
function packet(c,operations,id="operation") {
  const p={schema:"janseon-map-commands.v1",datasetId:c.authored.datasetId,baseGeneration:c.generationId,expectedSemanticHash:c.mapSemanticSha256,identitySnapshotHash:c.identitySnapshotSha256,operationId:id,operations};
  c.review.inputSha256=semanticDigest(p);c.review.permittedKinds=[...new Set(operations.map(o=>o.kind))].sort();return p;
}
const reject=(p,c,code)=>assert.throws(()=>validateAuthoringCommands(p,c),{code});

test("all fourteen kinds validate and reduce exact typed slots without mutating inputs",()=>{
  const c=fixture(), title=c.referenceEntities[0].ref;
  const operations=[
    op("entity.create",{entityRef:ref("authored-facility","new"),geographicParentRef:null,location:null,footprint:null}),
    op("entity.update",{entityRef:ref("authored-facility","new"),geographicParentRef:null,location:{crs:"OGC:CRS84",coordinates:[127,37]},footprint:null}),
    op("entity.tombstone",{entityRef:ref("authored-facility","new"),referenceResolutions:[]}),
    op("geometry.overlay.create",overlay("g")),op("geometry.overlay.set",{...overlay("g"),geometry:{crs:"OGC:CRS84",type:"Point",coordinates:[127.1,37]}}),
    op("graph.edge.create",edge("e")),op("graph.edge.change",{...edge("e"),a:station("a"),b:station("c")}),
    op("graph.crosswalk.create",cross("c")),op("graph.crosswalk.change",{...cross("c"),facilityRef:null}),
    op("placement.set",{personRef:person("a"),stationRef:station("b")}),op("holder.set",{titleRef:title,personRef:null}),
    op("owner.set",{settlementRef:ref("authored-settlement","s"),personRef:null}),op("control.set",{locationRef:station("a"),polityRef:null}),
    op("baseline.restore",{targetRef:person("a"),slot:"placement"})];
  const p=packet(c,operations), before=canonicalEncode({p,c});
  assert.equal(new Set(operations.map(o=>o.kind)).size,14);
  assert.deepEqual(validateAuthoringCommands(p,c),{schema:"janseon-command-validation.v1",inputSha256:semanticDigest(p)});
  const r=applyAuthoringCommands(p,c);
  assert.equal(canonicalEncode({p,c}),before);assert.deepEqual(r.release,{state:"unbuilt",mapReleaseId:null,deliveryReceiptId:null});
  assert.equal(r.newEdition.geometries[0].geometry.coordinates[0],127.1);
  assert.equal(r.newEdition.crosswalkChanges[0].facilityRef,null);assert.equal(r.newEdition.assignments.length,3);
  assert.equal(r.newEdition.tombstones.length,1);assert.ok(r.newEdition.editionId.startsWith("authored-sha256:"));
  assert.throws(()=>{r.newEdition.entities[0].location=3;},TypeError);
});

test("Q2a placement, null holder and owner survive; restore recovers pinned baseline",()=>{
  const c=fixture();c.authored.assignments=[{kind:"holder",subjectRef:c.referenceEntities[0].ref,valueRef:person("a")},{kind:"owner",subjectRef:ref("authored-settlement","s"),valueRef:person("b")},{kind:"placement",subjectRef:person("a"),valueRef:station("a")}];seal(c.authored);c.baseline=structuredClone(c.authored);
  const p=packet(c,[op("placement.set",{personRef:person("a"),stationRef:station("b")}),op("holder.set",{titleRef:c.referenceEntities[0].ref,personRef:null}),op("owner.set",{settlementRef:ref("authored-settlement","s"),personRef:null})]);
  const r=applyAuthoringCommands(p,c);assert.equal(r.newEdition.assignments[0].valueRef,null);assert.equal(r.newEdition.assignments[1].valueRef,null);assert.equal(r.newEdition.assignments[2].valueRef.sourceId,"b");
  const restore=packet(c,[...p.operations,op("baseline.restore",{targetRef:person("a"),slot:"placement"}),op("baseline.restore",{targetRef:c.referenceEntities[0].ref,slot:"holder"}),op("baseline.restore",{targetRef:ref("authored-settlement","s"),slot:"owner"})]);
  assert.deepEqual(applyAuthoringCommands(restore,c).newEdition.assignments.map(r=>r.valueRef.sourceId),["a","b","a"]);
});

test("set/change are existing-only and creation is explicit with no forward reference",()=>{
  for(const [kind,args] of [["geometry.overlay.set",overlay("g")],["graph.edge.change",edge("e")],["graph.crosswalk.change",cross("c")]]){
    const c=fixture();reject(packet(c,[op(kind,args)]),c,"E_COMMAND_REFERENCE");
    const create=kind.replace(/(?:set|change)$/,"create"), p=packet(c,[op(create,args),op(kind,args)]);assert.doesNotThrow(()=>validateAuthoringCommands(p,c));
    reject(packet(c,[op(create,args),op(create,args)]),c,"E_COMMAND_REFERENCE");
  }
  const c=fixture();reject(packet(c,[op("geometry.overlay.create",{...overlay("g"),ownerRef:ref("authored-facility","future")}),op("entity.create",{entityRef:ref("authored-facility","future"),geographicParentRef:null,location:null,footprint:null})]),c,"E_COMMAND_REFERENCE");
});

test("tombstone closure covers all incoming slots and rescan rejects self remaps",()=>{
  const c=fixture(), t=ref("authored-settlement","s");
  c.authored.entities[0].geographicParentRef=t;
  c.authored.geometries=[{ref:ref("authored-geometry","g"),ownerRef:t,geometry:{crs:"OGC:CRS84",type:"Point",coordinates:[127,37]}}];
  c.authored.crosswalkChanges=[{ref:ref("authored-crosswalk","c"),stationRef:station("a"),facilityRef:t,sourceReceipt:receipt}];
  c.authored.assignments=[{kind:"owner",subjectRef:t,valueRef:person("a")}];seal(c.authored);
  const resolutions=[{ownerRef:ref("authored-crosswalk","c"),slot:"crosswalk-facility",replacementRef:null},{ownerRef:ref("authored-facility","f"),slot:"geographic-parent",replacementRef:null},{ownerRef:ref("authored-geometry","g"),slot:"geometry-owner",replacementRef:null},{ownerRef:t,slot:"owner-subject",replacementRef:null}];
  const p=packet(c,[op("entity.tombstone",{entityRef:t,referenceResolutions:resolutions})]);
  const r=applyAuthoringCommands(p,c);assert.equal(r.newEdition.entities.length,1);assert.equal(r.newEdition.geometries.length,0);assert.equal(r.newEdition.assignments.length,0);assert.equal(r.newEdition.crosswalkChanges[0].facilityRef,null);
  reject(packet(c,[op("entity.tombstone",{entityRef:t,referenceResolutions:resolutions.slice(1)})]),c,"E_COMMAND_REFERENCE");
  reject(packet(c,[op("entity.tombstone",{entityRef:t,referenceResolutions:resolutions.map(r=>r.slot==="geographic-parent"?{...r,replacementRef:t}:r)})]),c,"E_COMMAND_REFERENCE");
});

test("current real tombstone coverage is missing, never an empty proof",()=>{
  const c=fixture();c.authored.datasetId="real-author";c.authored.entities.forEach(e=>e.ref.datasetId="real-author");seal(c.authored);c.baseline=structuredClone(c.authored);
  reject(packet(c,[op("entity.tombstone",{entityRef:c.authored.entities[0].ref,referenceResolutions:[]})]),c,"E_COMMAND_REFERENCE_COVERAGE");
});

test("replay survives later head and detects changed payload or corrupt result",()=>{
  const c=fixture(),p=packet(c,[op("placement.set",{personRef:person("a"),stationRef:null})]),r=applyAuthoringCommands(p,c);
  c.replay={datasetId:p.datasetId,operationId:p.operationId,inputSha256:semanticDigest(p),commandPackage:structuredClone(p),result:r};c.generationId=H("9");c.mapSemanticSha256=H("8");
  assert.equal(applyAuthoringCommands(p,c).replayed,true);
  const altered=structuredClone(p);altered.operationId="changed";reject(altered,c,"E_COMMAND_REPLAY");
  c.replay.result=structuredClone(r);c.replay.result.authoredSemanticSha256=H("0");reject(p,c,"E_COMMAND_REPLAY");
});

test("replay rejects a rehashed result bound to the wrong identity snapshot",()=>{
  const c=fixture(),p=packet(c,[op("placement.set",{personRef:person("a"),stationRef:station("a")})]);
  const r=structuredClone(applyAuthoringCommands(p,c));
  r.newEdition.identitySnapshotSha256=H("f");seal(r.newEdition);r.authoredSemanticSha256=r.newEdition.semanticSha256;
  c.replay={datasetId:p.datasetId,operationId:p.operationId,inputSha256:semanticDigest(p),commandPackage:structuredClone(p),result:r};
  reject(p,c,"E_COMMAND_REPLAY");
  assert.throws(()=>applyAuthoringCommands(p,c),{code:"E_COMMAND_REPLAY"});
});

test("replay rejects a rehashed dangling station with the correct identity hash",()=>{
  const c=fixture(),p=packet(c,[op("placement.set",{personRef:person("a"),stationRef:station("a")})]);
  const r=structuredClone(applyAuthoringCommands(p,c));
  r.newEdition.assignments[0].valueRef=station("missing");seal(r.newEdition);r.authoredSemanticSha256=r.newEdition.semanticSha256;
  assert.equal(r.newEdition.identitySnapshotSha256,p.identitySnapshotHash);
  c.replay={datasetId:p.datasetId,operationId:p.operationId,inputSha256:semanticDigest(p),commandPackage:structuredClone(p),result:r};
  reject(p,c,"E_COMMAND_REPLAY");
  assert.throws(()=>applyAuthoringCommands(p,c),{code:"E_COMMAND_REPLAY"});
});

test("replay requires its pinned historical context even when the head has advanced",()=>{
  const c=fixture(),p=packet(c,[op("placement.set",{personRef:person("a"),stationRef:station("a")})]),r=applyAuthoringCommands(p,c);
  c.replay={datasetId:p.datasetId,operationId:p.operationId,inputSha256:semanticDigest(p),commandPackage:structuredClone(p),result:r};
  c.generationId=H("9");assert.equal(applyAuthoringCommands(p,c).replayed,true);
  c.identitySnapshotSha256=H("f");c.identity.snapshotSha256=H("f");reject(p,c,"E_COMMAND_REPLAY");
});

test("shape, kinds, stale edition, binding, review, ordinals and immutable taxonomy",()=>{
  const base=()=>{const c=fixture();return [packet(c,[op("placement.set",{personRef:person("a"),stationRef:null})]),c];};
  for(const kind of ["patch","facility.create","settlement.update","geometry.drag-observed","graph.membership"]){const [p,c]=base();p.operations[0].kind=kind;reject(p,c,"E_COMMAND_KIND");}
  {const [p,c]=base();delete p.operations[0].args.stationRef;reject(p,c,"E_COMMAND_SHAPE");}
  {const [p,c]=base();p.operations[0].editionId="old";reject(p,c,"E_COMMAND_STALE");}
  {const [p,c]=base();p.expectedSemanticHash=H("0");reject(p,c,"E_COMMAND_BINDING");}
  {const [p,c]=base();c.review.inputSha256=H("0");reject(p,c,"E_COMMAND_REVIEW");}
  for(const id of ["/edges/01","/edges/-1","/edges/99"]){const c=fixture();reject(packet(c,[op("graph.edge.create",{...edge("e"),baseEdgeRef:ref("graph-edge",id,"synthetic:graph","g1")})]),c,"E_COMMAND_ORDINAL");}
  {const c=fixture();reject(packet(c,[op("entity.tombstone",{entityRef:ref("authored-facility","f"),referenceResolutions:[]}),op("entity.create",{entityRef:ref("authored-facility","f"),geographicParentRef:null,location:null,footprint:null})]),c,"E_COMMAND_IMMUTABLE");}
  {const [p,c]=base();let calls=0;Object.defineProperty(p,"datasetId",{get(){calls++;return "x";},enumerable:true});reject(p,c,"E_COMMAND_SHAPE");assert.equal(calls,0);}
  {const [p,c]=base();p.operations[0].targetEntityRefs=[];reject(p,c,"E_COMMAND_REFERENCE");}
});

test("geometry order, source immutability, unsafe coordinates and semantic determinism",()=>{
  const c=fixture(),before=canonicalEncode(c.central),args=overlay("g"),p=packet(c,[op("geometry.overlay.create",args)]);
  const a=applyAuthoringCommands(p,c),b=applyAuthoringCommands(p,c);assert.deepEqual(a,b);assert.equal(canonicalEncode(c.central),before);
  args.geometry.coordinates[0]=127.2;assert.equal(a.newEdition.geometries[0].geometry.coordinates[0],127);
  for(const coordinates of [[-0,37],[127,Infinity],[37,127],[127,37,1]]){const x=fixture(),bad=packet(x,[op("geometry.overlay.create",overlay("g"))]);bad.operations[0].args.geometry.coordinates=coordinates;reject(bad,x,"E_COMMAND_SHAPE");}
  const p2=packet(c,[op("geometry.overlay.create",overlay("g"))],"other");assert.equal(applyAuthoringCommands(p2,c).newEdition.editionId,a.newEdition.editionId);
});

test("resolutions never mutate a preceding created command and later dangling refs reject",()=>{
  const c=fixture(),t=ref("authored-settlement","s"),g={...overlay("g"),ownerRef:t};
  const p=packet(c,[op("geometry.overlay.create",g),op("entity.tombstone",{entityRef:t,referenceResolutions:[{ownerRef:g.geometryRef,slot:"geometry-owner",replacementRef:ref("authored-facility","f")}]})]);
  const before=canonicalEncode(p);assert.equal(applyAuthoringCommands(p,c).newEdition.geometries[0].ownerRef.sourceId,"f");assert.equal(canonicalEncode(p),before);
  reject(packet(c,[...p.operations,op("geometry.overlay.set",g)]),c,"E_COMMAND_REFERENCE");
});

test("baseline, graph-source grammar and source review failures retain exact codes",()=>{
  {const c=fixture();c.baseline.identitySnapshotSha256=H("0");seal(c.baseline);reject(packet(c,[op("baseline.restore",{targetRef:person("a"),slot:"placement"})]),c,"E_COMMAND_BASELINE");}
  {const c=fixture();c.central.graph.document.source.privateApproval="no";reject(packet(c,[op("placement.set",{personRef:person("a"),stationRef:null})]),c,"E_COMMAND_SHAPE");}
  {const c=fixture();c.review.sourceReceipts=[];reject(packet(c,[op("graph.edge.create",edge("e"))]),c,"E_COMMAND_REVIEW");}
});

