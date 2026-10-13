<?php
// Exit 0 once MariaDB accepts a connection with the WordPress credentials.
// Used instead of `wp db check` so the image doesn't need a MySQL client.
mysqli_report(MYSQLI_REPORT_OFF);
[$host, $port] = array_pad(explode(':', getenv('WORDPRESS_DB_HOST'), 2), 2, '3306');
$db = @mysqli_connect(
    $host,
    getenv('WORDPRESS_DB_USER'),
    getenv('WORDPRESS_DB_PASSWORD'),
    getenv('WORDPRESS_DB_NAME'),
    (int) $port
);
exit($db ? 0 : 1);
