import { MOUNT_CLASS_TO } from "../../config/debug";
import { numberThousandSplitter } from "../../helpers/number";
import { isObject, safeReplaceObject, copy } from "../../helpers/object";
import { Chat, ChatAdminRights, ChatBannedRights, ChatFull, ChatParticipants, InputChannel, InputChatPhoto, InputFile, InputPeer, SendMessageAction, Updates } from "../../layer";
import apiManager from '../mtproto/mtprotoworker';
import { RichTextProcessor } from "../richtextprocessor";
import rootScope from "../rootScope";
import apiUpdatesManager from "./apiUpdatesManager";
import appMessagesManager from "./appMessagesManager";
import appPeersManager from "./appPeersManager";
import appProfileManager from "./appProfileManager";
import appStateManager from "./appStateManager";
import appUsersManager from "./appUsersManager";

export type Channel = Chat.channel;

export type ChatRights = 'send' | 'edit_title' | 'edit_photo' | 'invite' | 'pin' | 'deleteRevoke' | 'delete';

export type UserTyping = Partial<{userId: number, action: SendMessageAction, timeout: number}>;

export class AppChatsManager {
  public chats: {[id: number]: Chat.channel | Chat.chat | any} = {};
  //public usernames: any = {};
  //public channelAccess: any = {};
  //public megagroups: {[id: number]: true} = {};
  public cachedPhotoLocations: {[id: number]: any} = {};

  public megagroupOnlines: {[id: number]: {timestamp: number, onlines: number}} = {};

  public typingsInPeer: {[peerId: number]: UserTyping[]} = {};

  constructor() {
    rootScope.on('apiUpdate', (e) => {
      // console.log('on apiUpdate', update)
      const update = e;
      switch(update._) {
        case 'updateChannel':
          const channelId = update.channel_id;
          //console.log('updateChannel:', update);
          rootScope.broadcast('channel_settings', {channelId: channelId});
          break;

        case 'updateUserTyping':
        case 'updateChatUserTyping': {
          if(rootScope.myId === update.user_id) {
            return;
          }
          
          const peerId = update._ === 'updateUserTyping' ? update.user_id : -update.chat_id;
          const typings = this.typingsInPeer[peerId] ?? (this.typingsInPeer[peerId] = []);
          let typing = typings.find(t => t.userId === update.user_id);
          if(!typing) {
            typing = {
              userId: update.user_id
            };

            typings.push(typing);
          }

          //console.log('updateChatUserTyping', update, typings);
          
          typing.action = update.action;
          
          if(!appUsersManager.hasUser(update.user_id)) {
            if(update._ === 'updateChatUserTyping') {
              if(update.chat_id && appChatsManager.hasChat(update.chat_id) && !appChatsManager.isChannel(update.chat_id)) {
                appProfileManager.getChatFull(update.chat_id);
              }
            }
            
            //return;
          }
          
          appUsersManager.forceUserOnline(update.user_id);

          if(typing.timeout !== undefined) clearTimeout(typing.timeout);

          typing.timeout = window.setTimeout(() => {
            delete typing.timeout;
            typings.findAndSplice(t => t.userId === update.user_id);
 
            rootScope.broadcast('peer_typings', {peerId, typings});

            if(!typings.length) {
              delete this.typingsInPeer[peerId];
            }
          }, 6000);

          rootScope.broadcast('peer_typings', {peerId, typings});
          break;
        }
      }
    });

    appStateManager.getState().then((state) => {
      this.chats = state.chats;
    });
  }

  public saveApiChats(apiChats: any[]) {
    apiChats.forEach(chat => this.saveApiChat(chat));
  }

  public saveApiChat(chat: any) {
    // * exclude from state
    // defineNotNumerableProperties(chat, ['rTitle', 'initials']);
    
    //chat.rTitle = chat.title || 'chat_title_deleted';
    chat.rTitle = RichTextProcessor.wrapRichText(chat.title, {noLinks: true, noLinebreaks: true}) || 'chat_title_deleted';

    const oldChat = this.chats[chat.id];

    chat.initials = RichTextProcessor.getAbbreviation(chat.title);

    if(chat.pFlags === undefined) {
      chat.pFlags = {};
    }

    if(chat.pFlags.min) {
      if(oldChat !== undefined) {
        return;
      }
    }

    if(chat._ === 'channel' &&
        chat.participants_count === undefined &&
        oldChat !== undefined &&
        oldChat.participants_count) {
      chat.participants_count = oldChat.participants_count;
    }

    /* if(chat.username) {
      let searchUsername = searchIndexManager.cleanUsername(chat.username);
      this.usernames[searchUsername] = chat.id;
    } */

    let changedPhoto = false, changedTitle = false;
    if(oldChat === undefined) {
      this.chats[chat.id] = chat;
    } else {
      const oldPhoto = oldChat.photo?.photo_small;
      const newPhoto = chat.photo?.photo_small;
      if(JSON.stringify(oldPhoto) !== JSON.stringify(newPhoto)) {
        changedPhoto = true;
      }

      if(oldChat.title !== chat.title) {
        changedTitle = true;
      }

      safeReplaceObject(oldChat, chat);
      rootScope.broadcast('chat_update', chat.id);
    }

    if(this.cachedPhotoLocations[chat.id] !== undefined) {
      safeReplaceObject(this.cachedPhotoLocations[chat.id], chat && 
        chat.photo ? chat.photo : {empty: true});
    }

    if(changedPhoto) {
      rootScope.broadcast('avatar_update', -chat.id);
    }

    if(changedTitle) {
      rootScope.broadcast('peer_title_edit', -chat.id);
    }
  }

  public getChat(id: number) {
    if(id < 0) id = -id;
    return this.chats[id] || {_: 'chatEmpty', id, deleted: true, access_hash: '', pFlags: {}/* this.channelAccess[id] */};
  }

  public hasRights(id: number, action: ChatRights, flag?: keyof ChatBannedRights['pFlags']) {
    const chat = this.getChat(id);
    if(chat._ === 'chatEmpty') return false;

    if(chat._ === 'chatForbidden' ||
        chat._ === 'channelForbidden' ||
        chat.pFlags.kicked ||
        (chat.pFlags.left && !chat.pFlags.megagroup)) {
      return false;
    }

    if(chat.pFlags.creator) {
      return true;
    }

    const rights = chat.admin_rights || chat.banned_rights || chat.default_banned_rights;
    let myFlags: {[flag in keyof ChatBannedRights['pFlags'] | keyof ChatAdminRights['pFlags']]: true};
    if(rights) myFlags = rights.pFlags;

    switch(action) {
      // good
      case 'send': {
        if(flag && myFlags && myFlags[flag]) {
          return false;
        }

        if(chat._ === 'channel') {
          if((!chat.pFlags.megagroup && !myFlags?.post_messages)) {
            return false;
          }
        }

        break;
      }

      // good
      case 'deleteRevoke': {
        if(chat._ === 'channel') {
          return !!myFlags?.delete_messages;
        } else if(!chat.pFlags.admin) {
          return false;
        }

        break;
      }

      // good
      case 'pin': {
        if(chat._ === 'channel') {
          return chat.admin_rights ? !!myFlags.pin_messages || !!myFlags.post_messages : myFlags && !myFlags.pin_messages;
        } else {
          if(myFlags?.pin_messages && !chat.pFlags.admin) {
            return false;
          }
        }

        break;
      }

      case 'edit_title':
      case 'edit_photo':
      case 'invite': {
        if(chat._ === 'channel') {
          if(chat.pFlags.megagroup) {
            if(!(action === 'invite' && chat.pFlags.democracy)) {
              return false;
            }
          } else {
            return false;
          }
        } else {
          if(chat.pFlags.admins_enabled &&
              !chat.pFlags.admin) {
            return false;
          }
        }

        break;
      }
    }

    return true;
  }

  /* public resolveUsername(username: string) {
    return this.usernames[username] || 0;
  } */

  /* public saveChannelAccess(id: number, accessHash: string) {
    this.channelAccess[id] = accessHash;
  } */

  /* public saveIsMegagroup(id: number) {
    this.megagroups[id] = true;
  } */

  public isChannel(id: number) {
    if(id < 0) id = -id;
    const chat = this.chats[id];
    if(chat && (chat._ === 'channel' || chat._ === 'channelForbidden')/*  || this.channelAccess[id] */) {
      return true;
    }
    return false;
  }

  public isMegagroup(id: number) {
    /* if(this.megagroups[id]) {
      return true;
    } */

    const chat = this.chats[id];
    if(chat && chat._ === 'channel' && chat.pFlags.megagroup) {
      return true;
    }
    return false;
  }

  public isBroadcast(id: number) {
    return this.isChannel(id) && !this.isMegagroup(id);
  }

  public getChannelInput(id: number): InputChannel {
    if(id < 0) id = -id;
    return {
      _: 'inputChannel',
      channel_id: id,
      access_hash: this.getChat(id).access_hash/*  || this.channelAccess[id] */ || 0
    };
  }

  public getChatInputPeer(id: number): InputPeer.inputPeerChat {
    return {
      _: 'inputPeerChat',
      chat_id: id
    };
  }

  public getChannelInputPeer(id: number): InputPeer.inputPeerChannel {
    return {
      _: 'inputPeerChannel',
      channel_id: id,
      access_hash: this.getChat(id).access_hash/*  || this.channelAccess[id] */ || 0
    };
  }

  public hasChat(id: number, allowMin?: true) {
    const chat = this.chats[id]
    return isObject(chat) && (allowMin || !chat.pFlags.min);
  }

  public getChatPhoto(id: number) {
    const chat = this.getChat(id);

    if(this.cachedPhotoLocations[id] === undefined) {
      this.cachedPhotoLocations[id] = chat && chat.photo ? chat.photo : {empty: true};
    }

    return this.cachedPhotoLocations[id];
  }

  public getChatString(id: number) {
    const chat = this.getChat(id);
    if(this.isChannel(id)) {
      return (this.isMegagroup(id) ? 's' : 'c') + id + '_' + chat.access_hash;
    }
    return 'g' + id;
  }

  public getChatMembersString(id: number) {
    const chat = this.getChat(id);
    const chatFull = appProfileManager.chatsFull[id];
    let count: number;
    if(chatFull) {
      if(chatFull._ === 'channelFull') {
        count = chatFull.participants_count;
      } else {
        count = (chatFull.participants as ChatParticipants.chatParticipants).participants?.length;
      }
    } else {
      count = chat.participants_count || chat.participants?.participants.length;
    }

    const isChannel = this.isBroadcast(id);
    count = count || 1;
    return numberThousandSplitter(count, ' ') + ' ' + (isChannel ? (count > 1 ? 'subscribers' : 'subscriber') : (count > 1 ? 'members' : 'member'));
  }

  public wrapForFull(id: number, fullChat: any) {
    const chatFull = copy(fullChat);
    const chat = this.getChat(id);

    if(!chatFull.participants_count) {
      chatFull.participants_count = chat.participants_count;
    }

    if(chatFull.participants &&
        chatFull.participants._ === 'chatParticipants') {
      chatFull.participants.participants = this.wrapParticipants(id, chatFull.participants.participants);
    }

    if(chatFull.about) {
      chatFull.rAbout = RichTextProcessor.wrapRichText(chatFull.about, {noLinebreaks: true});
    }

    //chatFull.peerString = this.getChatString(id);
    chatFull.chat = chat;

    return chatFull;
  }

  public wrapParticipants(id: number, participants: any[]) {
    const chat = this.getChat(id);
    const myId = appUsersManager.getSelf().id;
    if(this.isChannel(id)) {
      const isAdmin = chat.pFlags.creator;
      participants.forEach((participant) => {
        participant.canLeave = myId === participant.user_id;
        participant.canKick = isAdmin && participant._ === 'channelParticipant';

        // just for order by last seen
        participant.user = appUsersManager.getUser(participant.user_id);
      });
    } else {
      const isAdmin = chat.pFlags.creator || chat.pFlags.admins_enabled && chat.pFlags.admin;
      participants.forEach((participant) => {
        participant.canLeave = myId === participant.user_id;
        participant.canKick = !participant.canLeave && (
          chat.pFlags.creator ||
          participant._ === 'chatParticipant' && (isAdmin || myId === participant.inviter_id)
        );

        // just for order by last seen
        participant.user = appUsersManager.getUser(participant.user_id);
      });
    }

    return participants;
  }

  public createChannel(title: string, about: string): Promise<number> {
    return apiManager.invokeApi('channels.createChannel', {
      broadcast: true,
      title,
      about
    }).then((updates: any) => {
      apiUpdatesManager.processUpdateMessage(updates);

      const channelId = updates.chats[0].id;
      rootScope.broadcast('history_focus', -channelId);

      return channelId;
    });
  }

  public inviteToChannel(id: number, userIds: number[]) {
    const input = this.getChannelInput(id);
    const usersInputs = userIds.map(u => appUsersManager.getUserInput(u));

    return apiManager.invokeApi('channels.inviteToChannel', {
      channel: input,
      users: usersInputs
    }).then(updates => {
      apiUpdatesManager.processUpdateMessage(updates);
    });
  }

  public createChat(title: string, userIds: number[]): Promise<number> {
    return apiManager.invokeApi('messages.createChat', {
      users: userIds.map(u => appUsersManager.getUserInput(u)),
      title
    }).then(updates => {
      apiUpdatesManager.processUpdateMessage(updates);

      const chatId = (updates as any as Updates.updates).chats[0].id;
      rootScope.broadcast('history_focus', -chatId);

      return chatId;
    });
  }

  public async getOnlines(id: number): Promise<number> {
    if(this.isMegagroup(id)) {
      const timestamp = Date.now() / 1000 | 0;
      const cached = this.megagroupOnlines[id] ?? (this.megagroupOnlines[id] = {timestamp: 0, onlines: 1});
      if((timestamp - cached.timestamp) < 60) {
        return cached.onlines;
      }

      const res = await apiManager.invokeApi('messages.getOnlines', {
        peer: this.getChannelInputPeer(id)
      });

      const onlines = res.onlines ?? 1;
      cached.timestamp = timestamp;
      cached.onlines = onlines;

      return onlines;
    } else if(this.isBroadcast(id)) {
      return 1;
    }

    const chatInfo = await appProfileManager.getChatFull(id);
    const _participants = (chatInfo as ChatFull.chatFull).participants as ChatParticipants.chatParticipants;
    if(_participants && _participants.participants) {
      const participants = _participants.participants;

      return participants.reduce((acc: number, participant) => {
        const user = appUsersManager.getUser(participant.user_id);
        if(user && user.status && user.status._ === 'userStatusOnline') {
          return acc + 1;
        }

        return acc;
      }, 0);
    } else {
      return 1;
    }
  }

  private onChatUpdated = (chatId: number, updates: any) => {
    //console.log('onChatUpdated', chatId, updates);

    apiUpdatesManager.processUpdateMessage(updates);
    if(updates &&
        /* updates.updates &&
        updates.updates.length && */
        this.isChannel(chatId)) {
      appProfileManager.invalidateChannelParticipants(chatId);
    }
  };

  public leaveChannel(id: number) {
    return apiManager.invokeApi('channels.leaveChannel', {
      channel: this.getChannelInput(id)
    }).then(this.onChatUpdated.bind(this, id));
  }

  public joinChannel(id: number) {
    return apiManager.invokeApi('channels.joinChannel', {
      channel: this.getChannelInput(id)
    }).then(this.onChatUpdated.bind(this, id));
  }

  public deleteChatUser(id: number, userId: number) {
    return apiManager.invokeApi('messages.deleteChatUser', {
      chat_id: id,
      user_id: appUsersManager.getUserInput(userId)
    }).then(this.onChatUpdated.bind(this, id));
  }

  public leaveChat(id: number) {
    return this.deleteChatUser(id, appUsersManager.getSelf().id).then(() => {
      return appMessagesManager.flushHistory(-id);
    });
  }

  public leave(id: number) {
    return this.isChannel(id) ? this.leaveChannel(id) : this.leaveChat(id);
  }

  public deleteChannel(id: number) {
    return apiManager.invokeApi('channels.deleteChannel', {
      channel: this.getChannelInput(id)
    }).then(this.onChatUpdated.bind(this, id));
  }

  public migrateChat(id: number) {
    return apiManager.invokeApi('messages.migrateChat', {
      chat_id: id
    }).then(this.onChatUpdated.bind(this, id));
  }

  public editPhoto(id: number, inputFile: InputFile) {
    const inputChatPhoto: InputChatPhoto = {
      _: 'inputChatUploadedPhoto',
      file: inputFile
    };

    let promise: any;
    if(this.isChannel(id)) {
      promise = apiManager.invokeApi('channels.editPhoto', {
        channel: this.getChannelInput(id),
        photo: inputChatPhoto
      });
    } else {
      promise = apiManager.invokeApi('messages.editChatPhoto', {
        chat_id: id,
        photo: inputChatPhoto
      });
    }

    return promise.then((updates: any) => {
      apiUpdatesManager.processUpdateMessage(updates);
    });
  }

  public editTitle(id: number, title: string) {
    let promise: any;

    if(this.isChannel(id)) {
      promise = apiManager.invokeApi('channels.editTitle', {
        channel: this.getChannelInput(id),
        title
      });
    } else {
      promise = apiManager.invokeApi('messages.editChatTitle', {
        chat_id: id,
        title
      });
    }

    return promise.then((updates: any) => {
      apiUpdatesManager.processUpdateMessage(updates);
    });
  }

  public editAbout(id: number, about: string) {
    return apiManager.invokeApi('messages.editChatAbout', {
      peer: appPeersManager.getInputPeerById(-id),
      about
    }).then(bool => {
      //apiUpdatesManager.processUpdateMessage(updates);
      rootScope.broadcast('peer_bio_edit', -id);
    });
  }
}

const appChatsManager = new AppChatsManager();
MOUNT_CLASS_TO && (MOUNT_CLASS_TO.appChatsManager = appChatsManager);
export default appChatsManager;
