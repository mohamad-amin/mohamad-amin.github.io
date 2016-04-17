<?php

ignore_user_abort(true);//if caller closes the connection (if initiating with cURL from another PHP, this allows you to end the calling PHP script without ending this one)
set_time_limit(0);

$hLock=fopen(__FILE__.".lock", "w+");
if(!flock($hLock, LOCK_EX | LOCK_NB))
    die("Already running. Exiting...");

while (true) {

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, 'http://www.mohandesplus.ir/api/telegrambot/getUpdateCLI.php'); //the file or url to run
    curl_setopt($ch, CURLOPT_HEADER, false); // i don't want a response header
    curl_setopt($ch, CURLOPT_NOBODY, true); //i don't want it to display anything

    curl_exec($ch);
    curl_close($ch);
    sleep(30);

}

flock($hLock, LOCK_UN);
fclose($hLock);
unlink(__FILE__.".lock");