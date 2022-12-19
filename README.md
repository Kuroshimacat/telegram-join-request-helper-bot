# telegram-join-request-helper-bot
本机器人具备telegram群组的审核管理功能，由Sunafterrain编写。

## 免责声明

**任何使用本机器人导致的任何问题，本仓库的编写者/设计者/参与者不负任何责任，您应当在使用前对代码进行检查。**

## 要求

* 应已安装pnpm相关软件
* 本bot要求两个群组，需要私有群和公开群，在群组中都应为具有一定权限的管理员。

## 安装

1. 从[BotFather](https://botfather.t.me)获取Bot的token

2. git至本地

   ```bash
   git clone https://github.com/sunafterrainwm/telegram-join-request-helper-bot
   ```

3. 移动至文件夹

4. 编辑config文件，示例为[config.example.json5](https://github.com/sunafterrainwm/telegram-join-request-helper-bot/blob/master/config.example.json5)（所有用法在json5中均有注释）

5. 完成修改后，更改名为config.json5

   ```bash
   mv config.example.json5 config.json5
   ```

6. 如不编译启动，则执行：

   ```bash
   pnpm run ts-start
   ```

   如要编译为js再执行：

   ```bash
   pnpm run build && pnpm start 
   ```

   

## 许可

* [LICENCE](https://github.com/sunafterrainwm/telegram-join-request-helper-bot/blob/master/LICENSE)

  

## 开发者

* [Sunafterrainwm](https://github.com/sunafterrainwm)
* [Avwwww](https://github.com/owen15571)（owen15571）（Readme编写者）
