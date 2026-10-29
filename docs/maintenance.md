# Evidence auditů

Podrobné lokální záznamy patří do `docs/audits/YYYY-MM-DD/`. Celá složka
`docs/audits/` je na přání správce v `.gitignore`; její obsah se neodešle do Gitu
a nebude dostupný v novém klonu. Potřebné záznamy je proto nutné zálohovat samostatně.

Každý audit obsahuje:

- `01-findings.md`: výchozí commit, očíslované nálezy, reprodukce, závažnost a míru ověření.
- `02-fixes.md`: co, kde a proč bylo opraveno, návaznosti a skutečné výsledky ověření.
- Případné platformní záznamy a protokoly z testů.

Čísla nálezů se během oprav nemění. Nepotvrzený nález se nesmí vydávat za
reprodukovanou chybu; vyvrácení patří do záznamu stejně jako oprava. Úspěšný test
na simulátoru není ověřením fyzického zařízení.

Důvod oprav musí zůstat dohledatelný i bez lokální složky: v regresních testech,
stručných komentářích u netriviálních změn a přehledu v `CHANGELOG.md`.
