Inofficiell app. Inte kopplad till, godkänd av eller supportad av SATS.

Låt hemmet reagera på dina bokade SATS-pass. Lägg till varje SATS-medlem i hushållet som en enhet och använd sedan flöden för att:

- Göra något ett visst antal minuter innan ett bokat pass börjar, till exempel öppna gardinerna i sovrummet en timme före ett morgonpass.
- Reagera när ett pass slutar, ställs in eller byter instruktör.
- Få besked när du flyttas från väntelistan till bokad, eller när din köplats ändras.
- Kontrollera om ett pass börjar en viss tid och veckodag, ligger inom ett avstånd hemifrån eller är på ett av dina hemmacenter.

Enheten visar ditt nästa bokade pass, ditt nästa pass i kö och din bästa köplats. En widget för instrumentpanelen visar veckans pass för alla medlemmar.

Så fungerar det: du loggar in en gång med ditt eget SATS-konto när du lägger till enheten. Appen sparar bara en inloggningstoken på din Homey och glömmer lösenordet. Den läser dina bokningar ungefär var 30:e minut. Den kan inte boka eller avboka pass.

Appen använder samma privata API som SATS mobilapp. SATS kan ändra API:et när som helst, och då slutar appen fungera tills den har uppdaterats. Använd den bara med ditt eget konto, på egen risk.

Källkod, dokumentation och ärenden: https://github.com/magpern/homey-sats
