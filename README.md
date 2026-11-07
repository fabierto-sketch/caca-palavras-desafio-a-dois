# CAÇA-PALAVRAS ONLINE – DESAFIO A DOIS

**Olhos atentos, mente rápida e palavras escondidas!**

Projeto dedicado a Alberto e Bernardete.
*Estamos juntos, amor… Sempre.*

Caça-palavras online para duas pessoas, cada uma no seu computador ou telemóvel. Podem jogar **juntas**, na mesma grelha e com a mesma pontuação, ou **uma contra a outra**, cada uma com a sua pontuação. Tem conversa, reações, videochamada, estatísticas permanentes e um painel de administração em `/admin`.

---

## 1. O que está feito (e foi testado)

### Jogo
- **Dois modos**
  - **Jogar juntos.** Grelha e lista partilhadas. Cada palavra encontrada aparece logo aos dois, marcada com a cor de quem a encontrou (azul para o primeiro jogador, rosa para o segundo). Pontuação e tempo são conjuntos, com bónus de conclusão e de rapidez. Há mensagens divertidas, editáveis no painel.
  - **Um contra o outro.** A grelha é a mesma e as palavras estão nas mesmas posições. Cada um seleciona, progride e pontua por si, e vê a pontuação e o número de palavras do outro em tempo real.
    - **Nunca recebe que palavras o adversário encontrou nem onde estão.** O servidor filtra o estado e os eventos de cada jogador; isto está verificado nos testes automáticos.
    - Há bónus para quem termina primeiro e penalização configurável por erro. É possível «terminar a minha parte».
    - Os resultados mostram o vencedor ou o empate, as pontuações, as palavras, o tempo, a precisão da seleção e a diferença de pontos.
- **Grelhas:** 8×8, 10×10, 12×12, 15×15, 18×18 e 20×20, mais dimensões extra definidas no painel (6 a 26).
- **Direções:** as 8, incluindo diagonais e palavras ao contrário. A progressão é real:
  - Fácil: só →, ↓ e ↘.
  - Médio: inclui ← e ↑.
  - Difícil e Especialista: todas as direções, palavras mais compridas, letras de enchimento que «enganam» e menos pistas (2 no Especialista).
- **Gerador próprio com semente**
  - Coloca as palavras antes do enchimento e só cruza palavras em letras iguais.
  - Não deixa palavras dentro de outras e verifica que cada palavra aparece **exatamente uma vez**.
  - Tenta de novo quando falha (até 40 tentativas).
  - A grelha, a solução e a semente ficam guardadas na base de dados, o que permite repetir uma partida e auditá-la.
- **Validação estrita no servidor:** início, fim, direção, continuidade e correspondência exata. Aceita a seleção nos dois sentidos e recusa seleções aproximadas.
- **Seleção**
  - **Rato:** carregar, arrastar e largar.
  - **Toque:** arrastar em qualquer direção, sem a página deslizar; ou tocar na primeira e na última letra.
  - **Teclado:** setas e Enter para marcar o início e o fim; Esc cancela.
  - A seleção encaixa sempre numa das 8 direções.
  - **Certa:** marcação com a cor do jogador, animação, som e atualização da lista e da pontuação.
  - **Errada:** indicação discreta e penalização configurável, sem bloquear o jogo.
  - Nunca dá pontos duplicados.
- **31 categorias com 2154 palavras em português de Portugal, com acentos.** A validação ignora acentos, «ç», espaços e hífenes, sem alterar o que se mostra. Há ainda a categoria virtual «Todas as categorias».
- **Palavras secretas:** algumas grelhas têm uma palavra escondida que só mostra o tamanho e uma dica, e dá um bónus.
- **Anti-repetição permanente:** fica registado que palavras cada jogador (por navegador) e cada sala já viram.
  - A partida seguinte escolhe primeiro palavras novas, depois as vistas há mais tempo.
  - Uma grelha só se repete se o anfitrião carregar em «Repetir esta grelha».
- **Pontuação** (toda editável no painel)
  - Palavra curta 10, média 15, longa 20, muito longa 30.
  - Conclusão +50; bónus de rapidez por segundo poupado; +30 para quem termina primeiro no desafio.
  - Erro −2; palavra secreta +10.
  - Os números sobem com animação.
- **Tempo**
  - Cada partida pode ter tempo ou não ter limite. O relógio é contado no servidor e mostrado em contagem decrescente.
  - Perto do fim, há um alerta visual e um som.
  - A partida termina sozinha quando se encontram todas as palavras ou quando o tempo acaba.
  - O relógio pára se alguém perder a ligação.
  - Pausa: só com o acordo dos dois, ou só pelo anfitrião, ou desligada (definição no painel). Durante a pausa as letras ficam escondidas.
- **Desafios especiais:** 60 segundos, 3 minutos, 5 minutos, relâmpago (pontos a dobrar), diário (a mesma grelha para todos durante o dia, hora de Lisboa) e fim de semana (só ao sábado e ao domingo). No painel podem criar-se outros.
- **Pistas:** primeira letra (assinalada na grelha), direção, destacar zona (por uns segundos) e pequena indicação.
  - Cada pista tem um custo configurável e há um máximo por dificuldade.
  - No modo juntos são partilhadas; no desafio são independentes.
  - «Revelar palavra» só existe se o administrador a ativar.

### Salas, convívio e vídeo
- **Salas sem contas**
  - Criar uma sala gera um código único de 6 caracteres e um link de convite (`/sala/CÓDIGO`). Os nomes são escritos por cada um.
  - O anfitrião escolhe modo, dificuldade, categoria, grelha, tempo e desafio; a outra pessoa vê tudo em tempo real.
  - Há indicação de quem está ligado e um terceiro jogador é recusado.
  - A ligação recupera-se sozinha: recarregar a página ou perder a rede devolve o mesmo lugar e a partida a meio.
  - Abrir a sala noutra janela desliga a anterior.
- **Conversa:** mensagens com emojis, histórico da sessão, indicador «está a escrever…», mensagens rápidas (editáveis) e reações animadas (❤️ 👏 🔥 😂 …).
- **Videochamada WebRTC** com câmara e microfone (ligar e desligar cada um) e volume.
  - A janela minimiza-se e arrasta-se, e dá para continuar a jogar durante a chamada. Desligar a chamada não tira ninguém da sala.
  - A chamada é direta entre os dois e **nunca é gravada**.
  - O jogo funciona sem vídeo.
  - STUN gratuito incluído; TURN por variáveis de ambiente (ver secção 5).

### Aspeto
- **Visual quente e cuidado:** azulejo português discreto no fundo, papel creme, dourado e pôr do sol.
  - **Modo noite** com céu estrelado.
  - Letras grandes e legíveis (tipo de letra Lexend).
  - Marcações tipo «marcador», arredondadas e com a cor de cada um.
- **Página inicial animada:** ilustração Porto ↔ Rio com um coração a atravessar o oceano, e logótipo próprio.
- **Ecrãs:**
  - cartões de modo e de categoria;
  - barra de progresso;
  - mensagens flutuantes;
  - confettis com corações na vitória;
  - ecrã de resultados;
  - estatísticas com gráficos;
  - revisão da grelha resolvida.
- **Sons discretos** (desligáveis, com volume) e **música ambiente opcional**, gerada no próprio navegador. Há uma opção para desligar animações.
- **Modo Portugal ❤️ Brasil:** categoria especial com Porto, Rio de Janeiro, Portugal, Brasil, viagens, amor, carinho, cumplicidade, música, memórias, sonhos e lugares especiais. Todas as palavras têm dica.
  - Durante o jogo aparece «Mesmo separados por um oceano, continuam a jogar lado a lado.».
  - Na vitória aparece «Alberto e Bernardete: mais uma partida vencida juntos!» e a assinatura «Estamos juntos, amor… Sempre. ❤️».
  - Tudo é editável no painel e a categoria pode ser desativada.
- Responsivo: computador, tablet e telemóvel.

### Estatísticas permanentes
- **«Nós dois»** (por sala) e **«Eu»** (por navegador, em todas as salas):
  - partidas, vitórias juntos, vitórias individuais, derrotas e empates;
  - pontos totais, melhor pontuação e melhor tempo;
  - palavras encontradas, precisão e pistas;
  - categorias favoritas e dificuldades, com gráficos;
  - evolução da pontuação;
  - adversários e parceiros.
- **Partidas anteriores:** podem rever-se com a grelha resolvida.
- **Recordes:** juntos por pontos, juntos mais rápidos, desafio e desafio diário de hoje.
- **Apagar o histórico da sala:** só com o acordo dos dois (pode desligar-se no painel).

### Painel de administração (`/admin`)
- **Resumo:**
  - jogadores ligados e partidas a decorrer;
  - totais e partidas por dia;
  - categorias e dificuldades mais jogadas;
  - salas ativas e últimas partidas.
- **Salas:** criar, copiar o convite, encerrar ou reabrir, apagar o histórico, eliminar.
- **Categorias e palavras:**
  - criar, editar, ativar ou desativar e eliminar categorias;
  - acrescentar, editar, desativar e eliminar palavras;
  - importar listas grandes (até 5000 linhas; formato `palavra :: dica`);
  - ver e remover palavras repetidas entre categorias;
  - **pré-visualizar uma grelha** gerada, com verificação.
- **Desafios:** criar, editar, ativar e eliminar (dimensão, dificuldade, categoria, tempo, número de palavras, multiplicador, agenda).
- **Partidas:** lista com filtros e, para cada partida, grelha, solução, semente e **auditoria** (a grelha guardada é verificada de novo).
- **Jogadores:** estatísticas por jogador.
- **Definições:**
  - pontuação, penalizações, custos e limites de pistas;
  - tempos por dificuldade, alerta de pouco tempo, modo de pausa e dimensões extra;
  - textos e mensagens do jogo, mensagens rápidas e o modo especial;
  - ligar ou desligar o chat, as reações e o vídeo, e escolher se os jogadores podem criar salas.
- **Manutenção:**
  - estado do servidor (base de dados, ligações, memória, se há TURN configurado, n.º de erros);
  - registo técnico com filtros;
  - **apagar dados de teste** (com confirmação escrita);
  - terminar todas as sessões.

### Segurança
- O cliente não decide nada: palavras, posições, pontos, pistas, tempo e vencedores são **validados e calculados no servidor**.
- **As soluções nunca saem do servidor durante a partida.** O navegador só recebe as letras da grelha, a lista de palavras a encontrar (as secretas só com tamanho e dica) e as posições das palavras já encontradas *por ele* (ou pelos dois, no modo juntos). No desafio, o adversário só recebe «encontrou uma palavra (+15)».
- Proteções contra abuso e manipulação:
  - submissões duplicadas;
  - controlo de permissões por sala (só o anfitrião configura e começa);
  - códigos de sala validados;
  - **limites de tentativas** (entrar em salas, criar salas, seleções, mensagens, login do painel);
  - eventos desconhecidos recusados.
- **Painel protegido no servidor:**
  - a palavra-passe fica só na variável `ADMIN_PASSWORD`;
  - a sessão é um cookie `HttpOnly`/`SameSite=Strict` guardado com *hash*;
  - pedidos de alteração exigem um cabeçalho anti-CSRF;
  - 8 tentativas falhadas bloqueiam 15 minutos.
- Cabeçalhos de segurança (CSP, `nosniff`, etc.). O registo técnico não guarda segredos.

---

## 2. Estrutura

```
package.json        server.js         render.yaml      README.md
.env.example        .gitignore
server/
  database.js       PostgreSQL (produção) ou SQLite (testes locais) + migrações
  generator.js      gerador de grelhas com semente, validação e auditoria
  game.js           regras: seleção, pontos, pistas, tempo, fim da partida
  rooms.js          salas, tempo real (Socket.IO), histórico e estatísticas
  words.js          categorias, palavras e anti-repetição
  challenges.js     desafios especiais
  settings.js       definições editáveis
  admin.js          API do painel
  webrtc.js         sinalização da videochamada e servidores STUN/TURN
  security.js, logger.js, env.js
data/categorias.js  banco inicial de palavras (importado no primeiro arranque)
public/
  index.html  style.css  app.js     jogo
  grid.js                           grelha e seleção (rato, toque, teclado)
  sound.js  charts.js  video.js     sons/música, gráficos, videochamada
  admin.html  admin.css  admin.js   painel
  sounds/  favicon.svg
test/
  run-tests.js      testes automáticos (gerador, regras e servidor real)
  e2e.js            teste no navegador (Playwright), opcional
.github/workflows/descompactar.yml   ajuda a enviar o .zip pelo site do GitHub
```

**Base de dados:** as tabelas são criadas e atualizadas automaticamente no arranque (migrações em `server/database.js`). O banco de palavras é importado na primeira vez e depois gere-se no painel.

---

## 3. Experimentar no computador

Precisa do **Node.js 22.13 ou mais recente** (versão LTS).

```bash
npm install
cp .env.example .env      # e mude ADMIN_PASSWORD
npm start
```

Abra `http://localhost:3000` em duas janelas (uma pode ser anónima) para jogar com «duas pessoas». O painel está em `http://localhost:3000/admin`.

Sem `DATABASE_URL`, os dados ficam num ficheiro SQLite (`data/local.db`) — serve só para testes.

---

## 4. Publicar (GitHub + Neon + Render, tudo gratuito)

### 4.1 GitHub
1. Crie um repositório novo (ex.: `caca-palavras-desafio-a-dois`).
2. **Add file → Create new file**. No nome escreva `.github/workflows/descompactar.yml` e cole o conteúdo do ficheiro com esse nome que está dentro do zip. Depois carregue em *Commit changes*.
3. **Add file → Upload files**, arraste o ficheiro `.zip` e faça *Commit changes*. Em cerca de um minuto o GitHub descompacta-o sozinho (separador *Actions*).
4. Confirme que na raiz do repositório aparecem `package.json`, `server.js`, `public/`, `server/`, etc.

Em alternativa, descompacte o zip no computador e arraste **o conteúdo da pasta** (não a pasta) em *Upload files*.

### 4.2 Neon (base de dados PostgreSQL)
1. Em neon.tech crie um projeto (região Europa, ex.: Frankfurt).
2. Copie a *connection string* (começa por `postgresql://` e termina em `?sslmode=require`).

### 4.3 Render (servidor)
1. **New → Web Service** e ligue o repositório do GitHub.
2. Preencha:

| Campo | Valor |
|---|---|
| Root Directory | **(deixar vazio)** |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |
| Health Check Path (em *Advanced*) | `/health` |

3. Em **Environment**, crie as variáveis (não crie `PORT`, o Render define-a sozinho):

| Variável | Valor |
|---|---|
| `ADMIN_PASSWORD` | a sua palavra-passe do painel (mínimo 6 caracteres) |
| `DATABASE_URL` | a ligação do Neon |
| `NODE_ENV` | `production` |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | opcionais (secção 5) |

4. **Create Web Service.** Nos *Logs* deve aparecer `Caça-Palavras Online a funcionar na porta …` e `base de dados postgres`.
5. Abra o endereço `https://….onrender.com`, crie uma sala e envie o link de convite.

Também pode usar **New → Blueprint** com o `render.yaml` incluído (pede `ADMIN_PASSWORD` e `DATABASE_URL`).

**Notas:**
- **Plano gratuito:** o serviço adormece após ~15 min sem visitas; a primeira visita demora ~1 minuto a acordar. Os dados não se perdem: estão no Neon.
- **Nada é guardado no disco do Render:** salas, partidas a meio, palavras e estatísticas estão na base de dados. Se o servidor reiniciar a meio de uma partida, os jogadores voltam ao mesmo ponto.
- Se mudar o código, basta enviar os ficheiros para o GitHub: o Render publica sozinho.

---

## 5. Videochamada: permissões, HTTPS e TURN

- **HTTPS:** os navegadores só deixam usar câmara e microfone em páginas seguras. No Render o endereço já é `https://`. Em `localhost` também funciona.
- **Permissões:** na primeira chamada o navegador pergunta se pode usar a câmara e o microfone. Se alguém recusar por engano, tem de as voltar a permitir no cadeado ao lado do endereço. Sem câmara ou microfone, ainda se pode ver e ouvir a outra pessoa.
- **STUN e TURN:**
  - O STUN gratuito (Google) já está incluído e chega para a maioria das redes de casa.
  - Em **redes móveis (4G/5G)**, redes de empresas ou routers restritivos, a ligação direta pode falhar. Nesses casos é preciso um **servidor TURN**, que serve de intermediário. Há planos gratuitos, por exemplo na Metered (metered.ca/stun-turn).
  - Copie de lá os valores para as variáveis `TURN_URL` (ou `TURN_URLS`, com vários separados por vírgulas), `TURN_USERNAME` e `TURN_CREDENTIAL`.
  - Em `/admin` → Manutenção vê se o TURN está configurado.
- **Gravações:** nada é gravado. O vídeo vai diretamente de um navegador para o outro (ou pelo TURN, cifrado); o servidor só troca as mensagens de ligação.
- O jogo funciona sem vídeo (e o vídeo pode ser desligado no painel).

---

## 6. Usar o painel

- **Entrar:** vá a `/admin` e escreva a palavra-passe definida em `ADMIN_PASSWORD`.
- **Importar palavras:** *Categorias e palavras* → escolha a categoria → cole a lista.
  - Uma palavra por linha (ou separadas por `;`).
  - Para pôr uma dica: `Pão de queijo :: Petisco mineiro`.
  - São aceites só letras (com acentos), espaços e hífenes, de 3 a 20 letras.
  - Repetidas na mesma categoria são ignoradas e indicadas.
- **Antes de jogar «a sério»:** *Manutenção* → **Apagar dados de teste**.
- **Alterar regras ou textos:** as alterações em *Definições* aplicam-se às partidas que começarem a seguir.

---

## 7. Testes realizados

### Automáticos — `npm test`
`test/run-tests.js` tem **25 testes**: 10 do gerador e das regras, e 15 com o servidor verdadeiro, jogado por Socket.IO como dois navegadores.
- **Resultado:** **25/25 aprovados com SQLite** e **25/25 com PostgreSQL 16** (local).
- **Gerador:** as 6 dimensões × 4 dificuldades × 4 categorias (96 grelhas) são todas verificadas; as 8 direções aparecem; cada palavra aparece exatamente uma vez; a mesma semente dá a mesma grelha; os acentos são normalizados.
- **Validação:** sentido direto e inverso; seleção curta, torta ou fora da grelha é recusada.
- **Regras:** pontos por comprimento, sem duplicados, penalização, pistas (custos, limite, partilha, «revelar» desligado), vencedor, empate e bónus de quem termina primeiro.
- **Servidor:**
  - `/health`;
  - salas: código e convite, terceiro jogador recusado, código inválido ou inexistente, só o anfitrião configura, evento desconhecido recusado;
  - modo juntos sincronizado e com quem encontrou;
  - desafio sem fuga de informação do adversário (nem no estado, nem nos eventos) e com pistas independentes;
  - fim por tempo, pausa com acordo, relógio parado ao desligar;
  - **reconexão** com o mesmo lugar e a partida a meio;
  - anti-repetição e «repetir grelha»;
  - histórico, revisão e recordes;
  - chat (limites e histórico) e reações;
  - sinalização da videochamada;
  - seleções inválidas;
  - **painel**: 401 sem sessão, palavra-passe errada, cookie HttpOnly, CSRF, validação de definições, categorias e importação, pré-visualização, confirmação para apagar, o registo não expõe a palavra-passe;
  - limite de tentativas de entrada;
  - cabeçalhos de segurança;
  - ficheiros do servidor e `.env` não acessíveis.

### No navegador — `npm run test:e2e`
`test/e2e.js` usa Playwright e Chromium. Corre dois navegadores reais: computador 1366×900 com rato e teclado, e **iPhone 13 simulado** com toque. A câmara e o microfone são simulados.
- **Resultado:** **17/17 passos aprovados** nas duas últimas execuções.
- **O que verifica:**
  - página inicial sem deslocamento horizontal no telemóvel;
  - criar sala e entrar pelo link;
  - configuração em tempo real;
  - seleção com **rato**, com **toque** (ao contrário) **sem a página deslizar** e com **teclado**;
  - penalização por erro e pista pela interface;
  - **pausa** pedida e aceite;
  - chat, mensagem rápida e reação;
  - **videochamada ligada nos dois sentidos**, a jogar durante a chamada, e desligar;
  - resultados (vencedor e precisão), revisão da grelha, estatísticas e recordes;
  - modo juntos com as cores de cada um;
  - recarregar a página e recuperar a partida;
  - modo escuro;
  - painel (entrada, pré-visualização, definições);
  - **zero erros de JavaScript**.
- **Capturas:** ficam em `test/screens/`.
- Para correr: `npm i -D playwright && npx playwright install chromium`.

### Limitações honestas
- **iPhone e Android:** não foram testados em aparelhos reais nem no Safari. O «iPhone 13» é a simulação do Chromium (ecrã, toque e user-agent). O código evita o deslocamento da página durante o toque também no Safari antigo (`touch-action: none` e `touchmove` com `preventDefault`), mas convém experimentarem nos vossos telemóveis.
- **Videochamada:** foi testada com câmara e microfone simulados, na mesma máquina. **Não foi testada entre redes diferentes nem com TURN**; entre redes móveis pode falhar sem TURN (secção 5).
- **Base de dados e alojamento:** o PostgreSQL foi testado localmente (versão 16), **não** no Neon nem no Render a partir daqui. O código é o mesmo que já funcionou convosco no Escape Room (mesma camada de base de dados e o mesmo arranque com `/health`).
- **Tipos de letra:** o ambiente de testes não tinha acesso à internet, por isso os tipos de letra do Google (Fraunces, Lexend, Nunito) não carregaram e as capturas usam tipos de letra de recurso. No vosso navegador o aspeto fica ainda mais próximo do pretendido.
- **Repetições e leitores de ecrã:**
  - A anti-repetição usa a identificação anónima de cada navegador: se alguém limpar os dados do navegador ou mudar de aparelho, passa a contar como «jogador novo» para as palavras já vistas. O histórico da sala mantém-se.
  - A grelha é navegável por teclado e anuncia a posição e a letra, mas não foi testada com um leitor de ecrã real.

---

> Não importa quem encontrou mais palavras. O importante é que continuamos a descobrir coisas juntos.
>
> Alberto ❤️ Bernardete
>
> Estamos juntos, amor… Sempre.
