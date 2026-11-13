# Traço — caderno ao vivo

Escreva em páginas em branco, pautadas, quadriculadas ou por cima de PDFs e
transmita ao vivo. Quem assiste abre o site e digita o código de 6 dígitos
da transmissão.

## Publicar na Cloudflare (grátis) — pelo computador

1. Crie uma conta gratuita em https://dash.cloudflare.com (só e-mail e senha).
2. Instale o Node.js (versão LTS) em https://nodejs.org.
3. Descompacte esta pasta, abra um terminal dentro dela e rode:

   ```
   npx wrangler login
   npx wrangler deploy
   ```

   O primeiro comando abre o navegador para você autorizar. O segundo publica
   e mostra o endereço do site, algo como `https://traco.SEU-NOME.workers.dev`.
   (Na primeira vez ele pede para você escolher esse "SEU-NOME".)

4. Abra o endereço, toque em **Entrar** e use o e-mail do administrador.
   **A senha que você digitar nesse primeiro login passa a ser a senha do
   administrador.** Faça isso logo depois de publicar.

Para atualizar o site depois de alguma mudança: `npx wrangler deploy` de novo.

### Sem computador (pelo GitHub)

Com os arquivos em um repositório do GitHub, no painel da Cloudflare vá em
**Workers & Pages → Create application → Import a repository**, escolha o
repositório, use o nome **traco** e toque em **Save and Deploy**. A
Cloudflare publica sozinha a cada alteração no repositório.

## Como usar

- **Administrador:** no início, toque no seu e-mail → **Usuários** para
  cadastrar quem pode transmitir (e-mail e senha). Lá também dá para remover.
- **Apresentador:** entre com sua conta, crie um caderno ou abra um PDF,
  escreva e toque em **Transmitir**. Aparece o código de 6 dígitos.
- **Quem assiste:** abre o site e digita o código. Não precisa de conta.
  Se não houver transmissão ao vivo com aquele código, aparece um erro.
- **No iPad:** em Safari, toque em Compartilhar → **Adicionar à Tela de
  Início**. O app abre em tela cheia e o Safari não apaga os cadernos sozinho.

## O que saber

- **Só os 10 cadernos mais recentes ficam guardados**, e ficam no aparelho
  onde foram criados (não na nuvem). Ao criar o 11º, o mais antigo é apagado.
  Exporte em PDF o que quiser manter (botão de download no caderno).
- As linhas do papel pautado/quadriculado aparecem só para o apresentador.
- Uma transmissão é encerrada se o apresentador ficar 3 minutos desconectado
  ou depois de 12 horas.
- Plano gratuito da Cloudflare: se a cota do dia acabar, o site para de
  transmitir até as 21h (horário de Belém) e volta sozinho. Não há cobrança.
- Os e-mails dos administradores não ficam escritos no projeto, só o resumo
  SHA-256 de cada um (`ADMIN_EMAIL_SHA256` em `wrangler.jsonc`, separados por
  vírgula). Para incluir outro administrador, acrescente o SHA-256 do e-mail
  dele, em minúsculas. No primeiro login ele define a própria senha.
- Contas de administrador não podem ser removidas pela tela de Usuários.

## Pastas

- `public/` — o app (páginas, escrita, PDF). `public/vendor/` é a biblioteca
  pdf.js (Mozilla, licença Apache 2.0) usada para abrir PDFs.
- `src/` — o servidor: login (`auth-core.js`), salas (`room-core.js`),
  rotas (`api.js`) e a ligação com a Cloudflare (`worker.js`).
- `dev/dev-server.mjs` — servidor para testar no computador
  (`npm i ws` e depois `node dev/dev-server.mjs`).
