import { CapacitorSqlite } from 'capacitor-sqlite';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    CapacitorSqlite.echo({ value: inputValue })
}
