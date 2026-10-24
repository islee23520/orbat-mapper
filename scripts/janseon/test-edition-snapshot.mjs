import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalEncode, semanticDigest } from "./canonical.mjs";
import { graphSemanticProjection } from "./graph-store.mjs";
import { observedGeographySemanticProjection } from "./observed-geography-store.mjs";
import { createReleaseManifest } from "./release-manifest.mjs";
import { createEditorSnapshot, validateEditorSnapshot, validateEditorSnapshotContents } from "./edition-snapshot.mjs";

const H = c => c.repeat(64);
const ref = (entityKind, sourceId, datasetId = "synthetic:author", editionId = "base") => ({ datasetId, editionId, entityKind, sourceId });
const person = id => ref("person", id, "synthetic:identity", "i1");
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

const sha=b=>createHash("sha256").update(b).digest("hex");
function fixture() {
  const central=sourceFixture(),source={schema:"wiki-map-identities.v1",visibility:"protected",verification:"trusted-snapshot/sealed-admitted-revision-projection",persons:[],polities:[],blocs:[],fieldProvenance:[]};
  const sourceBytes=Buffer.from(JSON.stringify(source,null,2)+"\n"),sourceHash=sha(sourceBytes);
  const identity={schema:"janseon-identity-reference.v1",projectionContract:"janseon-identity-index.v1",sourceContent:{contentId:"synthetic-identity-source",rawSha256:sourceHash,sizeBytes:sourceBytes.length,encoding:"wiki-json-pretty2-lf.v1"},sourceReceipt:{contentId:"synthetic-identity-receipt",sha256:H("b")},index:{snapshotSha256:sourceHash,entities:[]}};
  const authored=authoredFixture(central,sourceHash);
  const editions=[{domain:"graph",datasetId:central.graph.datasetId,editionId:central.graph.editionId,semanticSha256:central.graph.graphSemanticSha256},
    {domain:"initial-state",datasetId:authored.datasetId,editionId:authored.editionId,semanticSha256:authored.semanticSha256},
    {domain:"observed-geography",datasetId:central.observedGeography.datasetId,editionId:central.observedGeography.editionId,semanticSha256:central.observedGeography.observedGeographySemanticSha256}];
  const er=e=>{const {semanticSha256,...r}=e;return r;}, graph=er(editions[0]), initial=er(editions[1]), observed=er(editions[2]);
  const blobs=[{contentId:"authored",bytes:Buffer.from(canonicalEncode(authored))},{contentId:"central",bytes:Buffer.from(JSON.stringify(central)+"\n")},{contentId:"identity",bytes:Buffer.from(canonicalEncode(identity))}];
  const contents=blobs.map((b,i)=>({contentId:b.contentId,rawSha256:sha(b.bytes),sizeBytes:b.bytes.length,kind:["authored-reference","central-reference","identity-reference"][i],editionRefs:i===1?[graph,observed]:[initial],visibility:"protected",license:{id:"synthetic",textSha256:H("a")}}));
  const layer=(id,editionRefs,contentIds)=>({id,editionRefs,contentIds,sourceCoordinates:id==="subway-graph"?{crs:"graph-named-lat-lon",axisOrder:"latitude-longitude"}:{crs:"OGC:CRS84",axisOrder:"longitude-latitude"},displayTransform:{id:id==="subway-graph"?"graph-lon-lat-v1":"identity-crs84-v1",outputCrs:"OGC:CRS84",outputAxisOrder:"longitude-latitude"},movement:id==="subway-graph"?"explicit-graph":"none"});
  const input={schema:"janseon-map-snapshot.v1",datasetId:authored.datasetId,editionId:authored.editionId,generationId:H("2"),mapSemanticSha256:H("3"),identitySnapshotSha256:sourceHash,
    release:{state:"draft",mapReleaseId:null,deliveryReceiptId:null},sourceSnapshot:{contentId:"source-db",databaseSha256:H("4"),mapSemanticSha256:H("3")},identityReceipt:identity.sourceReceipt,
    sourceReceipts:editions.map((e,i)=>({editionRef:er(e),receipt:{contentId:"source-"+i,sha256:H("5")}})),editions,
    layers:[layer("authored-spatial",[initial],["authored","identity"]),layer("subway-graph",[graph],["central"]),layer("surface-observed",[observed],["central"])],contents};
  const context={schema:"janseon-editor-snapshot-context.v1",expectedDatasetId:input.datasetId,expectedEditionId:input.editionId,expectedGenerationId:input.generationId,expectedMapSemanticSha256:input.mapSemanticSha256,expectedIdentitySnapshotSha256:sourceHash,
    requiredLayers:input.layers.map(l=>l.id),expectedSourceSnapshot:structuredClone(input.sourceSnapshot),expectedIdentityReceipt:structuredClone(identity.sourceReceipt),
    expectedIdentityReferenceBinding:{sourceContent:structuredClone(identity.sourceContent),sourceReceipt:structuredClone(identity.sourceReceipt),indexSemanticSha256:semanticDigest(identity.index)},expectedSourceReceipts:structuredClone(input.sourceReceipts),releaseManifest:null,releaseContext:null,expectedContentDescriptors:structuredClone(contents)};
  return {input,context,blobs,central,identity,authored,sourceBytes};
}
function replaceBlob(f,id,value,raw=false) {
  const b=f.blobs.find(b=>b.contentId===id);b.bytes=raw?Buffer.from(value):Buffer.from(id==="central"?JSON.stringify(value)+"\n":canonicalEncode(value));
  const d=f.input.contents.find(d=>d.contentId===id);d.rawSha256=sha(b.bytes);d.sizeBytes=b.bytes.length;f.context.expectedContentDescriptors=structuredClone(f.input.contents);
}
const loaded=f=>validateEditorSnapshotContents(createEditorSnapshot(f.input,f.context),f.blobs,f.context);

test("draft snapshot binds opaque refs, loads exact pair with holes and preserves alias order",()=>{
  const f=fixture(),before=canonicalEncode(f.input),s=createEditorSnapshot(f.input,f.context);
  assert.deepEqual(validateEditorSnapshot(s,f.context),{snapshotSha256:s.snapshotSha256,mapReleaseId:null,deliveryReceiptId:null});
  assert.deepEqual(loaded(f),validateEditorSnapshot(s,f.context));assert.equal(canonicalEncode(f.input),before);
  assert.deepEqual(Object.keys(f.central.graph.document.aliases),["z","a"]);assert.equal(f.central.observedGeography.geometry.features[0].geometry.coordinates[0].length,2);
  assert.throws(()=>{s.layers[0].movement="x";},TypeError);
  f.input.layers[0].contentIds.push("later");assert.equal(s.layers[0].contentIds.length,2);
});

test("identity-reference canonical example matches every approved byte/hash value",()=>{
  const f=fixture(),b=f.blobs.find(b=>b.contentId==="identity");
  assert.equal(f.sourceBytes.length,219);assert.equal(sha(f.sourceBytes),"a542cce08969c3e22993d43c119e2b9f9afe528b2a9dfb27592b653437bc231e");
  assert.equal(b.bytes.length,524);assert.equal(semanticDigest(f.identity.index),"460383169e1bc7baaa0fc1480ab541aadd68de8d0358a7da4351ff168f44ff7c");
  assert.equal(sha(b.bytes),"ce11cb8bf779a64099de2d2635046cecb7f3c581d299015dd78f1cafec450e7d");assert.equal(sha(b.bytes),semanticDigest(f.identity));
});

test("missing, changed, duplicate and unlisted supplied blobs fail closed",()=>{
  {const f=fixture();f.blobs.pop();assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_CONTENT_MISSING"});}
  {const f=fixture();f.blobs[0].bytes[0]^=1;assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_CONTENT_DIGEST"});}
  {const f=fixture();f.blobs.push(f.blobs[0]);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});}
  {const f=fixture();f.blobs.push({contentId:"unknown",bytes:new Uint8Array([1])});assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});}
});

test("draft/released policy and expected source/identity/generation bindings",()=>{
  for(const change of [f=>{f.input.release.mapReleaseId=H("1");},f=>{f.input.release.state="released";},f=>{f.input.sourceSnapshot.databaseSha256=H("9");},f=>{f.input.editionId="wrong";},f=>{f.input.identitySnapshotSha256=H("9");}]){const f=fixture();change(f);assert.throws(()=>createEditorSnapshot(f.input,f.context),{code:"E_SNAPSHOT_BINDING"});}
  const f=fixture(),s=structuredClone(createEditorSnapshot(f.input,f.context));s.snapshotSha256=H("0");assert.throws(()=>validateEditorSnapshot(s,f.context),{code:"E_SNAPSHOT_DIGEST"});
});

test("required datasets, wrong edition roles, unsafe content ids and transform drift reject",()=>{
  {const f=fixture();f.context.requiredLayers=["physical-rail",...f.context.requiredLayers].sort();assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});}
  for(const id of ["../x","/x","C:\\x","%2e%2e","https://invalid"]){const f=fixture();f.input.contents[0].contentId=id;assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_SHAPE"});}
  {const f=fixture();f.input.layers[1].movement="none";assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});}
  {const f=fixture();f.input.layers[2].sourceCoordinates.axisOrder="latitude-longitude";assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_TRANSFORM"});}
  {const f=fixture();f.input.layers[2].editionRefs=[f.input.layers[1].editionRefs[0]];assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});}
});

test("rehashing identity payload cannot replace independent source/index authority",()=>{
  for(const mutate of [i=>{i.sourceContent.contentId="other";},i=>{i.sourceReceipt.sha256=H("8");},i=>{i.index.entities=[{ref:person("injected"),affiliationRefs:[],affiliationStatus:"none"}];}]){
    const f=fixture();mutate(f.identity);replaceBlob(f,"identity",f.identity);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_BINDING"});
  }
});

test("strict byte parsing rejects duplicate members, UTF8 errors, pointer text and noncanonical payload",()=>{
  for(const bytes of ['{"schema":"x","schema":"y"}',Buffer.from([0xff]),"version https://git-lfs.github.com/spec/v1\n",JSON.stringify(fixture().identity,null,2)+"\n"]){
    const f=fixture();replaceBlob(f,"identity",bytes,true);assert.throws(()=>loaded(f),e=>["E_SNAPSHOT_SHAPE","E_SNAPSHOT_CONTENT_DIGEST"].includes(e.code));
  }
  const f=fixture();let calls=0;Object.defineProperty(f.input,"datasetId",{get(){calls++;return "x";},enumerable:true});assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_SHAPE"});assert.equal(calls,0);
});

test("source alias sorting and geometry edits cannot hide behind rehashed transport",()=>{
  {const f=fixture();f.central.graph.document.aliases={a:"a",z:"b"};replaceBlob(f,"central",f.central);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_BINDING"});}
  {const f=fixture();f.central.observedGeography.geometry.features[0].geometry.coordinates[0][0][0][0]=128;replaceBlob(f,"central",f.central);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_BINDING"});}
  {const f=fixture();f.central.graph.document.aliases.z="unknown";replaceBlob(f,"central",f.central);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});}
});

test("authored reference digest and FK closure are checked, not just blob hashes",()=>{
  {const f=fixture();f.authored.entities[0].geographicParentRef=ref("authored-facility","missing");seal(f.authored);replaceBlob(f,"authored",f.authored);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});}
  {const f=fixture();f.authored.entities[0].location={crs:"OGC:CRS84",coordinates:[127.1,37]};replaceBlob(f,"authored",f.authored);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_BINDING"});}
});

test("political owner/control reject unresolved identities while placement and null remain valid",()=>{
  for(const kind of ["owner","control","placement"]){
    const f=fixture(),identityRef=kind==="control"?ref("polity","p","synthetic:identity","i1"):person("a");
    f.identity.index.entities=[{ref:identityRef,affiliationRefs:[],affiliationStatus:"unresolved"}];
    f.context.expectedIdentityReferenceBinding.indexSemanticSha256=semanticDigest(f.identity.index);
    replaceBlob(f,"identity",f.identity);
    const subjectRef=kind==="owner"?ref("authored-settlement","s"):kind==="control"?ref("graph-station","a","synthetic:graph","g1"):identityRef;
    const valueRef=kind==="placement"?ref("graph-station","a","synthetic:graph","g1"):identityRef;
    f.authored.assignments=[{kind,subjectRef,valueRef}];seal(f.authored);
    f.input.editions.find(e=>e.domain==="initial-state").semanticSha256=f.authored.semanticSha256;
    replaceBlob(f,"authored",f.authored);
    if(kind==="placement") assert.doesNotThrow(()=>loaded(f));
    else {
      assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});
      f.identity.index.entities[0].affiliationStatus="none";
      f.context.expectedIdentityReferenceBinding.indexSemanticSha256=semanticDigest(f.identity.index);
      replaceBlob(f,"identity",f.identity);assert.doesNotThrow(()=>loaded(f));
      f.identity.index.entities[0].affiliationStatus="unresolved";
      f.context.expectedIdentityReferenceBinding.indexSemanticSha256=semanticDigest(f.identity.index);
      replaceBlob(f,"identity",f.identity);
    }
    f.authored.assignments[0].valueRef=null;seal(f.authored);
    f.input.editions.find(e=>e.domain==="initial-state").semanticSha256=f.authored.semanticSha256;
    replaceBlob(f,"authored",f.authored);assert.doesNotThrow(()=>loaded(f));
  }
});

test("holder remains fail-closed without a typed title lane even for explicit null",()=>{
  const f=fixture();f.authored.assignments=[{kind:"holder",subjectRef:ref("title","t","synthetic:titles","t1"),valueRef:null}];
  seal(f.authored);f.input.editions.find(e=>e.domain==="initial-state").semanticSha256=f.authored.semanticSha256;
  replaceBlob(f,"authored",f.authored);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_REFERENCE"});
});

test("full released snapshot uses existing complete release R/P validation",()=>{
  const f=fixture(),ed=f.input.editions.map(({semanticSha256,...r})=>r),graph=ed[0],initial=ed[1],observed=ed[2];
  const specs=[["wiki/map-core.json","map-core",[graph]],["wiki/observed-geography.json","observed-geography",[observed]],["wiki/spatial-assignments.json","spatial-assignments",[initial]],["wiki/station-bindings.json","station-bindings",[graph]],["wiki/underground-geometry.json","underground-geometry",[graph]],["game/world-graph.json","world-graph",[graph]],["game/map-topology.json","map-topology",[observed]],["game/initial-world.json","initial-world",[graph,initial]],["game/terrain-manifest.json","terrain-manifest",[observed]]];
  const members=specs.map(([path,kind,editionRefs])=>({path,target:path.split("/")[0],kind,sizeBytes:1,rawSha256:H("a"),visibility:"public",license:{id:"synthetic",textSha256:H("a")},identitySnapshotSha256:f.input.identitySnapshotSha256,editionRefs})).sort((a,b)=>a.path<b.path?-1:1);
  const budget={schema:"janseon-map-release-budget.v1",migrationReceipt:{contentId:"migration",sha256:H("a")},members:members.map(m=>({path:m.path,maxBytes:1})),maxTotalBytes:9};
  const semantic={schema:"janseon-map-release-semantic.v1",projectionContract:"janseon-map-release-projection.v1",mapSemanticSha256:f.input.mapSemanticSha256,identitySnapshotSha256:f.input.identitySnapshotSha256,editions:f.input.editions,domains:{graph:{semanticSha256:f.input.editions[0].semanticSha256,editionRefs:[graph]},geometry:{semanticSha256:H("5"),editionRefs:[observed]},initialState:{semanticSha256:H("6"),editionRefs:[initial]}},targets:["wiki","game"],targetAllowlists:{wiki:members.filter(m=>m.target==="wiki").map(m=>m.path),game:members.filter(m=>m.target==="game").map(m=>m.path)},members};
  const provenance={sourceCommit:"a".repeat(40),snapshot:f.input.sourceSnapshot,exporter:{revision:"b".repeat(40),version:"1"},identityReceipt:f.input.identityReceipt,sourceReceipts:f.input.sourceReceipts,approvalReceipts:[{memberPaths:members.map(m=>m.path),receipt:{contentId:"approval",sha256:H("a")}}],budgetReceipt:{contentId:"budget",sha256:semanticDigest(budget)},memberLocations:members.map(m=>({path:m.path,storage:"git",contentId:null}))};
  f.context.releaseContext={expectedTargets:["wiki","game"],budget};f.context.releaseManifest=createReleaseManifest({semantic,provenance},f.context.releaseContext);
  f.input.release={state:"released",mapReleaseId:f.context.releaseManifest.mapReleaseId,deliveryReceiptId:f.context.releaseManifest.deliveryReceiptId};
  assert.equal(loaded(f).mapReleaseId,f.context.releaseManifest.mapReleaseId);
  f.input.release.deliveryReceiptId=H("0");assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_BINDING"});
});

test("declared legacy/rail blobs reject until their typed validators exist",()=>{
  for(const [domain,kind] of [["legacy-atlas","legacy-atlas-reference"],["physical-rail","physical-rail-reference"]]){
    const f=fixture(),e={domain,datasetId:"synthetic:"+domain,editionId:"one"},bytes=Buffer.from("{}");
    f.input.editions.push({...e,semanticSha256:H("a")});f.input.editions.sort((a,b)=>a.domain<b.domain?-1:1);
    f.input.sourceReceipts.push({editionRef:e,receipt:{contentId:"source-extra",sha256:H("a")}});f.input.sourceReceipts.sort((a,b)=>a.editionRef.domain<b.editionRef.domain?-1:1);
    f.context.expectedSourceReceipts=structuredClone(f.input.sourceReceipts);
    f.input.contents.push({contentId:"zz-extra",rawSha256:sha(bytes),sizeBytes:bytes.length,kind,editionRefs:[e],visibility:"protected",license:{id:"synthetic",textSha256:H("a")}});
    f.context.expectedContentDescriptors=structuredClone(f.input.contents);f.blobs.push({contentId:"zz-extra",bytes});
    assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_CONTENT_KIND"});
  }
});

test("source grammar and content accessors cannot be hidden by raw rehashing",()=>{
  {const f=fixture();f.central.graph.document.source.privateApproval="no";replaceBlob(f,"central",f.central);assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_SHAPE"});}
  {const f=fixture();let calls=0;Object.defineProperty(f.blobs[0],"bytes",{get(){calls++;return new Uint8Array();},enumerable:true});assert.throws(()=>loaded(f),{code:"E_SNAPSHOT_SHAPE"});assert.equal(calls,0);}
});

