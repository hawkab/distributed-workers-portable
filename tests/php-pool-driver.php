<?php
declare(strict_types=1);
require __DIR__.'/../php/pool.php';
$config=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);$root=$config['state_directory'];if(!is_dir($root))mkdir($root,0700,true);$lock=fopen($root.'/php-worker.lock','c+');if(!flock($lock,LOCK_EX|LOCK_NB))exit(2);
$admission=new class($root){public function __construct(private string $root){}public function sample(int $active):array{$n=is_file($this->root.'/pressure')?0:2;if($n===0){echo "paused\n";flush();}return ['max_concurrent_jobs'=>$n,'mode'=>'shared'];}};
fleet_pool($config,dirname(__DIR__),false,$lock,$admission);
