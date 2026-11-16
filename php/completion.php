<?php
declare(strict_types=1);
/* Loaded after FleetClient/FleetStore. No binary staging file is created. */
function fleet_json_string_tokens(string $text):Generator{
 yield '"';$offset=0;$length=strlen($text);
 while($offset<$length){$end=min($length,$offset+8192);while($end<$length&&$end>$offset&&(ord($text[$end])&0xc0)===0x80)$end--;if($end===$offset)throw new RuntimeException('completion_result_invalid_utf8');$encoded=json_encode(substr($text,$offset,$end-$offset),JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);yield substr($encoded,1,-1);$offset=$end;}
 yield '"';
}
function fleet_json_tokens(mixed $value,array $seen=[]):Generator{
 if(is_string($value)){yield from fleet_json_string_tokens($value);return;}
 if($value===null||is_bool($value)||is_int($value)||is_float($value)){yield json_encode($value,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);return;}
 if(is_object($value)){if(!$value instanceof stdClass)throw new RuntimeException('completion_result_not_json');$id=spl_object_id($value);if(isset($seen[$id]))throw new RuntimeException('completion_result_cycle');$seen[$id]=true;$object=true;$values=get_object_vars($value);}elseif(is_array($value)){$object=!array_is_list($value);$values=$value;}else throw new RuntimeException('completion_result_not_json');
 yield $object?'{':'[';$first=true;foreach($values as $key=>$item){if(!$first)yield ',';$first=false;if($object){yield from fleet_json_string_tokens((string)$key);yield ':';}yield from fleet_json_tokens($item,$seen);}yield $object?'}':']';
}
function fleet_completion_fits(array $completion,int $budget):bool{$length=0;foreach(fleet_json_tokens($completion) as $bytes){$length+=strlen($bytes);if($length>$budget)return false;}return true;}
function fleet_completion_artifact(array $completion,array $artifact):array{$completion['artifact_ids']=array_values(array_unique(array_merge($completion['artifact_ids']??[],[$artifact['artifact_id']])));return $completion;}
function fleet_prepare_completion(FleetClient $client,FleetStore $store,array $job,array $completion,array $config,callable $pulse):array{
 $budget=$config['control_bytes']??16777216;$chunkBytes=$config['chunk_bytes']??262144;if(!is_int($budget)||$budget<0||!is_int($chunkBytes)||$chunkBytes<=0)throw new RuntimeException('invalid_completion_budget');
 if(fleet_completion_fits($completion,$budget))return $completion;
 $result=$completion['result'];
 if(is_array($result)&&is_int($result['status']??null)&&is_string($result['url']??null)&&isset($result['headers'],$result['artifact']['artifact_id'])){$stripped=$result;unset($stripped['body_text'],$stripped['body_json']);$stripped['body_error']=['code'=>'control_budget_exceeded'];$candidate=$completion;$candidate['result']=$stripped;$candidate=fleet_completion_artifact($candidate,$result['artifact']);if(fleet_completion_fits($candidate,$budget))return $candidate;}
 $length=0;$digest=hash_init('sha256');foreach(fleet_json_tokens($result) as $bytes){$pulse(['phase'=>'completion_preparing']);$length+=strlen($bytes);hash_update($digest,$bytes);}$hash=hash_final($digest);$key='completion/'.$job['attempt_id'].'/'.$hash;
 $store->data['completion_transfers']??=[];$state=$store->data['completion_transfers'][$key]??['key'=>$key,'job_id'=>$job['id'],'attempt_id'=>$job['attempt_id'],'length'=>$length,'sha256'=>$hash];$save=function()use(&$state,$store,$key):void{$store->data['completion_transfers'][$key]=$state;$store->save();};$save();$identity=$client->identity($job);
 if(!isset($state['upload_id'])){$created=$client->request('POST','/v1/jobs/'.rawurlencode($job['id']).'/artifacts',$identity+['key'=>$key,'name'=>'result.json','media_type'=>'application/json']);$state['upload_id']=$created['upload_id'];$save();}
 $path='/v1/artifacts/'.rawurlencode($state['upload_id']);$status=$client->request('GET',$path.'/status',null,null,$job);if($status['cancel_requested']??false)throw new RuntimeException('cancelled');$artifact=$status['artifact']??($state['artifact']??null);$offset=$status['offset']??0;if(!is_int($offset)||$offset<0||$offset>$length)throw new RuntimeException('completion_upload_offset_invalid');
 if($artifact===null){$position=0;$buffer='';$skip=$offset;
  $send=function()use(&$buffer,&$offset,&$state,$client,$path,$job,$pulse,$save):void{if($buffer==='')return;$pulse(['phase'=>'completion_streaming','bytes'=>$offset]);$receipt=$client->request('PUT',$path.'/chunks/'.$offset,null,$buffer,$job);if(($receipt['offset']??-1)!==$offset||($receipt['next_offset']??-1)!==$offset+strlen($buffer))throw new RuntimeException('completion_chunk_ack_mismatch');$offset=$receipt['next_offset'];$state['offset']=$offset;$buffer='';$save();};
  foreach(fleet_json_tokens($result) as $bytes){$pulse(['phase'=>'completion_streaming','bytes'=>$offset]);$begin=max(0,$skip-$position);$position+=strlen($bytes);if($begin>=strlen($bytes))continue;while($begin<strlen($bytes)){$n=min($chunkBytes-strlen($buffer),strlen($bytes)-$begin);$buffer.=substr($bytes,$begin,$n);$begin+=$n;if(strlen($buffer)===$chunkBytes)$send();}}$send();$artifact=$client->request('POST',$path.'/finish',$identity+['length'=>$length,'sha256'=>$hash]);$state['artifact']=$artifact;$save();
 }
 if(($artifact['length']??-1)!==$length||($artifact['sha256']??null)!==$hash||!is_string($artifact['artifact_id']??null))throw new RuntimeException('completion_artifact_integrity_mismatch');
 $candidate=$completion;$candidate['result']=['artifact'=>$artifact,'result_format'=>'json','body_error'=>['code'=>'control_budget_exceeded']];$candidate=fleet_completion_artifact($candidate,$artifact);if(!fleet_completion_fits($candidate,$budget))throw new RuntimeException('completion_metadata_exceeds_control_budget');return $candidate;
}
